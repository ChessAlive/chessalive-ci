import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace as NS
import unittest
from unittest.mock import Mock
from datetime import datetime, timezone


SPEC = importlib.util.spec_from_file_location('cloud_snapshot', Path(__file__).with_name('cloud-resource-snapshot.py'))
snapshot = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(snapshot)
UTC = timezone.utc
NOW = datetime(2026, 10, 3, 6, 15, tzinfo=UTC)


def response(data, more=False):
    return NS(data=data, headers={'opc-next-page': 'opaque-page'} if more else {})


def collector(**overrides):
    models = NS(RequestSummarizedUsagesDetails=lambda **kw: NS(**kw), SummarizeMetricsDataDetails=lambda **kw: NS(**kw))
    sdk = NS(core=NS(ComputeClient='compute'), database=NS(DatabaseClient='database'),
             monitoring=NS(MonitoringClient='monitoring', models=models),
             usage_api=NS(UsageapiClient='usage', models=models), limits=NS(LimitsClient='limits'))
    value = snapshot.Collector(sdk, NS(tenancy_id='private-tenancy'),
                               {'region': 'ap-mumbai-1', 'compartmentId': 'private-compartment',
                                'shape': 'VM.Standard.A1.Flex', 'availabilityDomain': 'Mumbai-AD-1'}, now=NOW)
    clients = {name: Mock() for name in ('compute', 'database', 'monitoring', 'usage', 'limits')}
    clients.update(overrides)
    value.client = lambda cls, region=None: clients[cls]
    return value, clients


class CloudSnapshotTests(unittest.TestCase):
    def test_errors_do_not_leak_sdk_body_credentials_or_resource_ids(self):
        error = RuntimeError('secret password and ocid1.secret.payload and full request body')
        error.status, error.code = 403, 'Forbidden'
        result = snapshot.safe_call(lambda: (_ for _ in ()).throw(error))
        encoded = json.dumps(result)
        self.assertNotIn('password', encoded)
        self.assertNotIn('ocid1', encoded)
        self.assertEqual(result['error'], {'httpStatus': 403, 'code': 'Forbidden'})
        self.assertEqual(result['status'], 'unavailable')

    def test_latest_metric_preserves_provider_timestamp_and_ignores_nan(self):
        old = datetime(2026, 10, 3, 0, tzinfo=UTC)
        new = datetime(2026, 10, 3, 0, 5, tzinfo=UTC)
        streams = [NS(aggregated_datapoints=[NS(timestamp=new, value=0), NS(timestamp=NOW, value=float('nan'))]),
                   NS(aggregated_datapoints=[NS(timestamp=old, value=99)])]
        result = snapshot.latest_metric(streams, 'percent', 300)
        self.assertEqual(result['value'], 0)
        self.assertEqual(result['dataAt'], '2026-10-03T00:05:00Z')
        self.assertEqual(result['intervalSeconds'], 300)
        self.assertEqual(snapshot.latest_metric([], 'GB', 3600)['status'], 'unavailable')

    def test_usage_is_bounded_and_does_not_equate_consumption_with_free_tier(self):
        value, clients = collector()
        row = NS(service='Compute', sku_part_number='B123', unit='OCPU HOURS', region='ap-mumbai-1',
                 computed_quantity=192, time_usage_started=NOW.replace(day=1, hour=0, minute=0),
                 time_usage_ended=NOW.replace(hour=0, minute=0))
        clients['usage'].request_summarized_usages.return_value = response(NS(items=[row] * 101), more=True)
        result = value.usage()
        args, kwargs = clients['usage'].request_summarized_usages.call_args
        self.assertEqual(args[0].query_type, 'USAGE_ONLY')
        self.assertEqual(len(args[0].group_by), 4)
        self.assertEqual(args[0].tenant_id, 'private-tenancy')
        self.assertEqual(kwargs['limit'], 100)
        self.assertEqual(result['periodEndExclusive'], '2026-10-03T00:00:00Z')
        self.assertTrue(result['excludesCurrentDay'])
        self.assertEqual(len(result['rows']), 100)
        self.assertTrue(result['truncated'])
        self.assertEqual(result['rows'][0]['quantity'], 192)
        self.assertNotIn('private-tenancy', json.dumps(result))

    def test_month_boundary_does_not_claim_zero_usage_without_data(self):
        value, clients = collector()
        value.now = NOW.replace(day=1)
        result = value.usage()
        self.assertEqual(result['status'], 'unavailable')
        clients['usage'].request_summarized_usages.assert_not_called()

    def test_compute_caps_inventory_and_reports_incomplete_page(self):
        value, clients = collector()
        instance = NS(display_name='Production', lifecycle_state='RUNNING', shape='VM.Standard.A1.Flex',
                      shape_config=NS(ocpus=4, memory_in_gbs=24, networking_bandwidth_in_gbps=4),
                      metadata={'password': 'secret'})
        clients['compute'].list_instances.return_value = response([instance] * 51)
        result = value.compute()
        self.assertEqual(len(result['items']), 50)
        self.assertTrue(result['truncated'])
        self.assertNotIn('secret', json.dumps(result))
        clients['compute'].list_instances.assert_called_once_with('private-compartment', limit=50)

    def test_database_caps_resources_and_keeps_metric_failures_partial(self):
        value, clients = collector()
        database = NS(id='ocid1.autonomousdatabase.oc1.ap-mumbai-1.private', display_name='chessalive-adb',
                      lifecycle_state='AVAILABLE', is_free_tier=True, compute_model='ECPU', compute_count=1,
                      cpu_core_count=0, data_storage_size_in_gbs=20)
        clients['database'].list_autonomous_databases.return_value = response([database] * 3)
        value.metric = Mock(return_value=snapshot.unavailable('No data'))
        result = value.database()
        self.assertEqual(result['status'], 'partial')
        self.assertTrue(result['truncated'])
        self.assertEqual(len(result['items']), 2)
        self.assertEqual(value.metric.call_count, 16)
        self.assertTrue(result['items'][0]['isFreeTier'])
        self.assertNotIn('ocid1', json.dumps(result))

    def test_metric_uses_exact_database_and_preserves_byte_window(self):
        value, clients = collector()
        clients['monitoring'].summarize_metrics_data.return_value = response([NS(aggregated_datapoints=[NS(timestamp=NOW, value=900)])])
        result = value.metric('ocid1.autonomousdatabase.oc1.ap-mumbai-1.private', 'SQLNetBytesToClient')
        args = clients['monitoring'].summarize_metrics_data.call_args.args
        self.assertEqual(args[0], 'private-compartment')
        self.assertIn('[5m]{resourceId=', args[1].query)
        self.assertTrue(args[1].query.endswith('.sum()'))
        self.assertEqual(result['unit'], 'bytes')
        self.assertEqual(result['intervalSeconds'], 300)
        self.assertEqual(value.metric('bad"query', 'CpuUtilization')['status'], 'unavailable')
        self.assertEqual(clients['monitoring'].summarize_metrics_data.call_count, 1)

    def test_limits_use_exact_shape_names_and_preserve_scope(self):
        value, clients = collector()
        def limits(tenancy, service, **kwargs):
            self.assertEqual((tenancy, service), ('private-tenancy', 'compute'))
            self.assertIn(kwargs['name'], ['standard-a1-core-count', 'standard-a1-memory-count'])
            return response([NS(name=kwargs['name'], value=100, scope_type='AD', availability_domain='Mumbai-AD-1'),
                             NS(name=kwargs['name'], value=999, scope_type='AD', availability_domain='Other-AD')])
        clients['limits'].list_limit_values.side_effect = limits
        clients['limits'].get_resource_availability.return_value = response(NS(used=4, available=96, effective_quota_value=100))
        result = value.limits()
        self.assertEqual(len(result['items']), 2)
        self.assertEqual(result['items'][0]['availability']['available'], 96)
        self.assertEqual(result['items'][0]['availabilityDomain'], 'Mumbai-AD-1')
        self.assertNotIn('freeTier', result)
        self.assertEqual(clients['limits'].list_limit_values.call_count, 2)
        self.assertEqual(clients['limits'].get_resource_availability.call_count, 2)

    def test_empty_limits_do_not_claim_complete_available_quotas(self):
        value, clients = collector()
        clients['limits'].list_limit_values.return_value = response([], more=True)
        result = value.limits()
        self.assertEqual(result['status'], 'unavailable')
        self.assertTrue(result['truncated'])
        clients['limits'].get_resource_availability.assert_not_called()

    def test_independent_failures_and_no_invented_entitlements(self):
        value, _ = collector()
        value.compute = Mock(return_value={'status': 'available', 'items': []})
        value.database = Mock(side_effect=RuntimeError('secret details'))
        value.usage = Mock(return_value={'status': 'available', 'rows': [{'quantity': 192}]})
        value.limits = Mock(return_value={'status': 'available', 'items': [{'limit': 100}]})
        result = value.collect()
        self.assertEqual(result['compute']['status'], 'available')
        self.assertEqual(result['database']['status'], 'unavailable')
        self.assertIsNone(result['freeTier']['remaining'])
        self.assertEqual(result['freeTier']['status'], 'unavailable')
        self.assertNotIn('secret details', json.dumps(result))


if __name__ == '__main__':
    unittest.main()
