# live/

Optional adapter for a real Podman. Not implemented yet.

Plan: a small local proxy (`tools/podcity-proxy`) forwards the libpod REST API
(`podman system service`) and streams `podman events --format json` over
SSE. This module translates those into `SimEvent`s so the rest of the app is
identical in simulated and live mode.
