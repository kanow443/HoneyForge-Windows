#!/bin/sh
set -eu
alembic upgrade head
hf-admin init
exec hf-api
