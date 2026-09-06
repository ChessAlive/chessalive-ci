# Separated admin operations

The public ChessAlive app no longer exposes an Admin route, Admin navigation button, or admin
studio chunk. The admin feature source was moved here so privileged operations remain part of the
Hyderabad control plane rather than shipping in the player-facing production bundle.

`source/apps/player-app/src/features/admin/` contains the extracted admin studio, ceremony,
character-release, OG-pack, stitch, and voice tooling. `docs/15-admin.md` is the related operations
contract. These files are kept out of the production web build; future admin-console changes belong
in this repository.

The production server's authorization checks remain in place as a safety boundary for existing
privileged endpoints. This repository is the owner of how those endpoints are operated; removing
the server-side checks would make the production machine less safe.
