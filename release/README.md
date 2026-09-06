# Hyderabad release lane

`build-trigger.mjs` serves the authenticated release dashboard. `local-release.sh` runs the build
on the Hyderabad host, and `deploy-chessd.sh` sends the tested ARM64 artifacts to Mumbai over the
dedicated deploy key. Neither script calls Jenkins, Cloud Build, or a remote build service.
