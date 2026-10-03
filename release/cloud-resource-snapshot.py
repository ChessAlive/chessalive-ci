#!/usr/bin/env python3
"""Bounded, read-only OCI inventory and usage. Emits no credentials or connection data.

Run on OCI with the installed Python SDK and existing instance-principal permissions.
Provider usage and service quotas are not free-tier entitlements. This adapter never
guesses an allowance or derives a monthly balance from host network counters.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
import re
import time
import urllib.request


UTC = timezone.utc
MAX_INSTANCES = 50
MAX_DATABASES = 2
MAX_USAGE_ROWS = 100
MAX_LIMITS = 4
METRICS = {
    'CpuUtilization': ('percent', '5m', 'mean', 300),
    'SgaUtilization': ('percent', '5m', 'mean', 300),
    'PgaUtilization': ('percent', '5m', 'mean', 300),
    'SessionUtilization': ('percent', '5m', 'mean', 300),
    'StorageUsed': ('GB', '1h', 'max', 3600),
    'StorageMax': ('GB', '1h', 'max', 3600),
    'SQLNetBytesFromClient': ('bytes', '5m', 'sum', 300),
    'SQLNetBytesToClient': ('bytes', '5m', 'sum', 300),
}


def iso(value):
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat().replace('+00:00', 'Z')
    return None


def number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def label(value):
    return str(value)[:180] if value is not None else None


def unavailable(reason, error=None):
    result = {'status': 'unavailable', 'reason': reason}
    if error is not None:
        status = getattr(error, 'status', None)
        code = getattr(error, 'code', None)
        # SDK error messages can contain URLs, OCIDs and request bodies. Never emit them.
        safe_code = code if isinstance(code, str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', code) else type(error).__name__
        result['error'] = {'httpStatus': status if isinstance(status, int) else None, 'code': safe_code}
        if status in (401, 403, 404):
            result['reason'] = 'Provider access is not authorized for this data, or the resource is unavailable.'
    return result


def safe_call(fn):
    try:
        return fn()
    except Exception as error:
        return unavailable('Provider data could not be collected.', error)


def response_truncated(response, count, maximum):
    return bool(getattr(response, 'headers', {}).get('opc-next-page')) or count > maximum


def latest_metric(streams, unit, interval_seconds):
    points = [point for stream in streams for point in (getattr(stream, 'aggregated_datapoints', None) or [])
              if isinstance(getattr(point, 'timestamp', None), datetime) and number(getattr(point, 'value', None)) is not None]
    if not points:
        return unavailable('No provider datapoint was returned in the collection window.')
    latest = max(points, key=lambda point: point.timestamp)
    return {'status': 'available', 'value': latest.value, 'unit': unit,
            'dataAt': iso(latest.timestamp), 'intervalSeconds': interval_seconds}


def usage_period(now):
    # DAILY requests end on a UTC boundary. The current incomplete day is excluded.
    end = now.astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    return end.replace(day=1), end


class Collector:
    def __init__(self, sdk, signer, metadata, region=None, database_region=None, usage_region=None, now=None):
        self.sdk, self.signer, self.metadata = sdk, signer, metadata
        self.region = region or metadata.get('canonicalRegionName') or metadata['region']
        self.database_region = database_region or self.region
        self.usage_region = usage_region or self.region
        self.compartment = metadata['compartmentId']
        self.tenancy = signer.tenancy_id
        self.now = now or datetime.now(UTC)

    def client(self, cls, region=None):
        return cls({'region': region or self.region}, signer=self.signer,
                   timeout=(2, 3), retry_strategy=self.sdk.retry.NoneRetryStrategy())

    def compute(self):
        response = self.client(self.sdk.core.ComputeClient).list_instances(self.compartment, limit=MAX_INSTANCES)
        values = response.data or []
        items = []
        for value in values[:MAX_INSTANCES]:
            shape = getattr(value, 'shape_config', None)
            items.append({'name': label(value.display_name), 'state': label(value.lifecycle_state),
                          'shape': label(value.shape), 'ocpus': number(getattr(shape, 'ocpus', None)),
                          'memoryGB': number(getattr(shape, 'memory_in_gbs', None)),
                          'networkBandwidthGbps': number(getattr(shape, 'networking_bandwidth_in_gbps', None))})
        return {'status': 'available', 'region': self.region, 'scope': 'instance compartment',
                'items': items, 'truncated': response_truncated(response, len(values), MAX_INSTANCES)}

    def metric(self, resource_id, name):
        unit, interval, statistic, seconds = METRICS[name]
        if not re.fullmatch(r'ocid1\.autonomousdatabase\.[A-Za-z0-9_.-]+', resource_id):
            return unavailable('The provider returned an invalid database resource identifier.')
        details = self.sdk.monitoring.models.SummarizeMetricsDataDetails(
            namespace='oci_autonomous_database',
            query=f'{name}[{interval}]{{resourceId={json.dumps(resource_id)}}}.{statistic}()',
            start_time=self.now - timedelta(hours=6), end_time=self.now)
        response = self.client(self.sdk.monitoring.MonitoringClient, self.database_region).summarize_metrics_data(
            self.compartment, details)
        return latest_metric(response.data or [], unit, seconds)

    def database(self):
        response = self.client(self.sdk.database.DatabaseClient, self.database_region).list_autonomous_databases(
            self.compartment, limit=MAX_DATABASES + 1)
        values = response.data or []
        items = []
        for value in values[:MAX_DATABASES]:
            resource_id = value.id
            with ThreadPoolExecutor(max_workers=4) as executor:
                futures = {name: executor.submit(safe_call, lambda name=name: self.metric(resource_id, name)) for name in METRICS}
                metrics = {name: future.result() for name, future in futures.items()}
            free = getattr(value, 'is_free_tier', None)
            items.append({'key': hashlib.sha256(resource_id.encode()).hexdigest()[:12],
                          'name': label(value.display_name), 'state': label(value.lifecycle_state),
                          'isFreeTier': free if isinstance(free, bool) else None,
                          'computeModel': label(getattr(value, 'compute_model', None)),
                          'computeCount': number(getattr(value, 'compute_count', None)),
                          'ocpus': number(getattr(value, 'cpu_core_count', None)),
                          'storageGB': number(getattr(value, 'data_storage_size_in_gbs', None)),
                          'metrics': metrics})
        complete = all(metric['status'] == 'available' for item in items for metric in item['metrics'].values())
        return {'status': 'available' if complete else 'partial', 'region': self.database_region,
                'scope': 'instance compartment', 'items': items,
                'truncated': response_truncated(response, len(values), MAX_DATABASES)}

    def usage(self):
        start, end = usage_period(self.now)
        base = {'periodStart': iso(start), 'periodEndExclusive': iso(end), 'excludesCurrentDay': True,
                'region': self.usage_region, 'scope': 'tenancy', 'source': 'OCI Usage API',
                'note': 'Provider-reported consumption through completed UTC days; reporting can lag. This is not a free-tier balance.'}
        if start == end:
            return {**base, **unavailable('No completed UTC day is available in this month yet.'), 'rows': [], 'truncated': False}
        details = self.sdk.usage_api.models.RequestSummarizedUsagesDetails(
            tenant_id=self.tenancy, time_usage_started=start, time_usage_ended=end,
            granularity='DAILY', is_aggregate_by_time=True, query_type='USAGE_ONLY',
            group_by=['service', 'skuPartNumber', 'unit', 'region'])
        try:
            response = self.client(self.sdk.usage_api.UsageapiClient, self.usage_region).request_summarized_usages(
                details, limit=MAX_USAGE_ROWS)
        except Exception as error:
            return {**base, **unavailable('Provider usage is unavailable.', error), 'rows': [], 'truncated': False}
        values = getattr(response.data, 'items', None) or []
        rows = [{'service': label(getattr(value, 'service', None)), 'skuName': label(getattr(value, 'sku_name', None)),
                 'skuPartNumber': label(getattr(value, 'sku_part_number', None)), 'unit': label(getattr(value, 'unit', None)),
                 'region': label(getattr(value, 'region', None)), 'quantity': number(getattr(value, 'computed_quantity', None)),
                 'dataStart': iso(getattr(value, 'time_usage_started', None)),
                 'dataEnd': iso(getattr(value, 'time_usage_ended', None))} for value in values[:MAX_USAGE_ROWS]]
        return {**base, 'status': 'available', 'rows': rows,
                'truncated': response_truncated(response, len(values), MAX_USAGE_ROWS)}

    def limits(self):
        client = self.client(self.sdk.limits.LimitsClient)
        family = re.fullmatch(r'VM\.Standard\.(A1|E5)\.Flex', self.metadata.get('shape', ''), re.I)
        if not family:
            return unavailable('No compute limit mapping is configured for this instance shape.')
        # Exact-name filters avoid silently omitting these limits behind a first page
        # of unrelated GPU/legacy shapes. Only this host's shape and AD are requested.
        names = [f'standard-{family[1].lower()}-{resource}-count' for resource in ('core', 'memory')]
        responses = [client.list_limit_values(self.tenancy, 'compute', name=name, limit=20) for name in names]
        relevant = [value for response in responses for value in (response.data or [])
                    if value.name in names and (not getattr(value, 'availability_domain', None)
                    or value.availability_domain == self.metadata.get('availabilityDomain'))]
        if not relevant:
            return {**unavailable('The provider returned no matching limits for this instance shape and availability domain.'),
                    'region': self.region, 'items': [],
                    'truncated': any(response_truncated(response, len(response.data or []), 20) for response in responses)}
        items = []
        for value in relevant[:MAX_LIMITS]:
            options = {}
            if getattr(value, 'availability_domain', None):
                options['availability_domain'] = value.availability_domain
            availability = safe_call(lambda: self.limit_availability(client, value.name, options))
            items.append({'name': label(value.name), 'scopeType': label(getattr(value, 'scope_type', None)),
                          'availabilityDomain': label(getattr(value, 'availability_domain', None)),
                          'limit': number(getattr(value, 'value', None)), 'availability': availability})
        return {'status': 'available' if all(item['availability']['status'] == 'available' for item in items) else 'partial',
                'region': self.region, 'scope': 'compute service limits; availability in instance compartment',
                'note': 'Provisioning quotas are not free-tier entitlements.', 'items': items,
                'truncated': len(relevant) > MAX_LIMITS or any(response_truncated(response, len(response.data or []), 20) for response in responses)}

    def limit_availability(self, client, name, options):
        value = client.get_resource_availability('compute', name, self.compartment, **options).data
        return {'status': 'available', 'used': number(getattr(value, 'used', None)),
                'available': number(getattr(value, 'available', None)),
                'effectiveQuota': number(getattr(value, 'effective_quota_value', None)),
                'fractionalUsage': number(getattr(value, 'fractional_usage', None)),
                'fractionalAvailability': number(getattr(value, 'fractional_availability', None))}

    def collect(self):
        with ThreadPoolExecutor(max_workers=4) as executor:
            futures = {name: executor.submit(safe_call, getattr(self, name)) for name in ('compute', 'database', 'usage', 'limits')}
            result = {name: future.result() for name, future in futures.items()}
        return {**base_snapshot(), 'region': self.region, 'auth': {'status': 'available', 'method': 'instance_principal'},
                **result}


def base_snapshot():
    return {'schemaVersion': 1, 'provider': 'oci', 'sampledAtMs': int(time.time() * 1000),
            'freeTier': {'status': 'unavailable', 'remaining': None,
                         'reason': 'Exact free-tier entitlement and remaining allowance are not supplied by these APIs. Usage, quotas and free-tier resource labels are reported separately.'}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--region')
    parser.add_argument('--database-region')
    parser.add_argument('--usage-region')
    args = parser.parse_args()
    try:
        import oci
        request = urllib.request.Request('http://169.254.169.254/opc/v2/instance/', headers={'Authorization': 'Bearer Oracle'})
        with urllib.request.urlopen(request, timeout=3) as response:
            metadata = json.load(response)
        signer = oci.auth.signers.InstancePrincipalsSecurityTokenSigner(
            timeout=(2, 3), retry_strategy=oci.retry.NoneRetryStrategy())
        result = Collector(oci, signer, metadata, args.region, args.database_region, args.usage_region).collect()
    except Exception as error:
        failure = unavailable('OCI instance-principal authentication or SDK is unavailable on this host.', error)
        result = {**base_snapshot(), 'auth': failure, **{name: failure for name in ('compute', 'database', 'usage', 'limits')}}
    print(json.dumps(result, allow_nan=False, separators=(',', ':')))


if __name__ == '__main__':
    main()
