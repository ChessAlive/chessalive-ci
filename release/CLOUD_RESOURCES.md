# Provider resource snapshot

`cloud-resource-snapshot.py` collects read-only OCI data using the installed OCI
Python SDK and the host's existing instance principal. Run it independently on
Hyderabad and Mumbai: they belong to different tenancies. Host memory and network
counters remain the separate, faster `resource-snapshot.py` collector.

Hyderabad uses `python3`; Mumbai's existing SDK interpreter is
`/opt/oci-cli-venv/bin/python3`. The script can be passed on SSH stdin without
installing it on production. Cache each provider response independently for five
minutes. Apply a 45-second process timeout; every SDK request disables retries and
has a two-second connect/three-second read timeout. No request writes resources,
changes policies, reads Vault secrets, or queries application database tables.

## Scope and bounds

- Compute: one page, at most 50 instances in the instance's compartment and region.
- Databases: at most two Autonomous Databases in that same compartment and region;
  eight metric queries each, with a six-hour window and at most four concurrent
  metric requests. Resource OCIDs and connection strings are excluded from output.
- Usage: one page of at most 100 rows for the **host's tenancy**, grouped by service,
  SKU part number, unit and region. UTC month-to-date through completed days only;
  OCI reporting can lag. The current day is excluded, and an empty first-day window
  is unavailable, not zero consumption.
- Limits: exact CPU/memory limit names for the host's A1 or E5 shape, at most 20
  results per name; availability is read only for the host's availability domain
  or applicable regional scope. At most four availability reads. Truncated pages
  are explicitly marked, and no matching limits means unavailable.

The optional `--region`, `--database-region` and `--usage-region` flags select
regions **within the authenticated tenancy**. They do not cross tenancy boundaries.
The default region always comes from that host's instance metadata.

## Data contract

JSON `schemaVersion: 1` contains `provider`, `sampledAtMs`, `region`, `auth`,
`compute`, `database`, `usage`, `limits` and `freeTier`. Each section independently
reports `status: available | partial | unavailable`. Errors expose only safe SDK
codes and HTTP status, never raw messages, request bodies or credentials.

`database.items[].isFreeTier` is the actual OCI resource label. The provider's
`computeModel` distinguishes ECPU from OCPU; do not replace it with the legacy
OCPU field when ECPU is set. Database metric entries have `value`, `unit`, `dataAt`
and `intervalSeconds`. Storage is sampled hourly; SGA/PGA metrics are sampled in
five-minute intervals. Network values are bytes **during the stated interval**,
not instantaneous bytes/second. Preserve the provider timestamp in the UI.

`usage.rows[].quantity` is provider consumption in that row's `unit`. Preserve
region and SKU grouping and never sum quantities across different units.
`limits.items[].availability` is provisioning quota availability, not free-tier
credit. Neither API establishes contractual free-tier entitlement or remaining
allowance, so `freeTier.remaining` stays null. A verified free database's remaining
storage may be shown separately from fresh `StorageMax - StorageUsed` measurements.

## Read permissions

The collector never provisions permissions. An operator may grant these narrow
read policies to a dynamic group matching the exact monitoring instance:

```text
Allow dynamic-group <group> to inspect instances in compartment <compartment>
Allow dynamic-group <group> to inspect autonomous-databases in compartment <compartment>
Allow dynamic-group <group> to read metrics in compartment <compartment> where target.metrics.namespace = 'oci_autonomous_database'
Allow dynamic-group <group> to inspect limits in tenancy
Allow dynamic-group <group> to read resource-availability in compartment <compartment>
Allow dynamic-group <group> to read usage-report in tenancy
```

These permissions do not provide admin actions, secret access, database SQL
access or instance console/SSH access. The implementation reports denied reads
honestly and continues collecting the sections already accessible.

Sources: [OCI service limits](https://docs.oracle.com/en-us/iaas/Content/General/service-limits/overview.htm),
[OCI usage access](https://docs.oracle.com/en-us/iaas/Content/Billing/Concepts/costanalysisoverview.htm),
[Autonomous Database metrics](https://docs.oracle.com/en-us/iaas/autonomous-database-serverless/doc/autonomous-monitor-metrics-list.html).

Tests run with `node --test release/cloud-resource-snapshot.test.mjs` or
`python3 -B release/cloud_resource_snapshot_test.py`; they use mocks and do not
contact production or OCI.
