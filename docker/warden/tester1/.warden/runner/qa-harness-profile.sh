#!/usr/bin/env bash

# The SSH forced command starts a login shell, so keep the task-local harness
# ahead of the immutable image toolchain after /etc/profile resets PATH.
export PATH="/workspace/.qa-harness/bin:/opt/runner-tools/node_modules/.bin:/usr/local/bin:/usr/bin:/bin"
