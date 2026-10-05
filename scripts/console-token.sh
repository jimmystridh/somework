#!/usr/bin/env bash
# Prints a fresh administrator bearer token (valid ~5 minutes) for the console's token login or curl.
cd "$(dirname "$0")/../run" && ../dist/somework admin --config somework.toml token --key root.key.json
