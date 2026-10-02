# Hyderabad release lane

`build-trigger.mjs` serves the authenticated release dashboard. `local-release.sh` runs the build
on the Hyderabad host, and `deploy-chessd.sh` sends the tested ARM64 artifacts to Mumbai over the
dedicated deploy key. Neither script calls Jenkins, Cloud Build, or a remote build service.

## Build measurements

The console timestamps explicit step events from the release scripts, including parallel server,
migration-tool, and browser jobs. Total elapsed time is wall-clock time for the whole release;
parallel step times are not added together. Skipped steps are shown as skipped. A step that never
started has no duration.

During a release, the console samples the local build process tree's resident memory (RSS) once
per second. It includes child processes and surviving members of the build process group, and
excludes unrelated host processes and the Mumbai service. The peak is the largest observed sample,
not a kernel high-water mark; short spikes may be missed and shared pages may be counted more than
once. A step's RAM peak is the build-tree peak observed while that step was running, so overlapping
steps share the same measurement scope. Missing samples are unavailable rather than zero.

The latest release, step timings, and a bounded memory chart are saved in `.state/latest-release.json`
(or `BUILD_STATE_FILE`). Finished results survive console restarts. If a restart interrupts a run,
the console marks it interrupted and freezes its timings at the last saved observation. Restart the
service only when `/health` reports that no release is running. Releases from before instrumentation
can retain their overall timing, but cannot acquire historical per-step times or memory samples.

Run `npm test` for metrics, authentication/persistence, and isolated shell pipeline regression checks.
