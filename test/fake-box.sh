#!/bin/sh
# A stand-in for the test box in the tests of the server: they already run inside a session sandbox, where Seatbelt
# cannot nest (sandbox_apply: Operation not permitted). Runs its arguments as they are.
exec "$@"
