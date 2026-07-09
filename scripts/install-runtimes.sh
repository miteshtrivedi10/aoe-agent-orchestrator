#!/usr/bin/env bash
# One-time, idempotent runtime installer.
# Downloads Python 3.12, Python 3.14, OpenJDK 21, and Node 22+ into the
# persistent /data/installs/ volume so they survive container restarts.
# Each block checks for a sentinel binary and skips if already present, so this
# script is cheap (sub-second) on every boot after the first.
#
# The server spawns this in the background at boot; progress is piped to the
# ring buffer. PATH is managed by entrypoint.sh (which prepends these bin dirs).
set -euo pipefail

INSTALLS=/data/installs
mkdir -p "$INSTALLS"

install_node_22() {
  local target="$INSTALLS/node/22"
  [ -f "$target/bin/node" ] && { echo "node 22+ already installed"; return 0; }
  mkdir -p "$target"
  local url="https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz"
  echo "downloading node 22+..."
  curl -fsSL "$url" | tar xJ -C "$target" --strip-components=1
  echo "node 22+ installed to $target"
}

install_python_312() {
  local target="$INSTALLS/python/3.12"
  [ -f "$target/bin/python3.12" ] && { echo "python 3.12 already installed"; return 0; }
  mkdir -p "$target"
  local url="https://github.com/astral-sh/python-build-standalone/releases/download/20250410/cpython-3.12.10+20250410-x86_64-unknown-linux-gnu-install_only.tar.gz"
  echo "downloading python 3.12..."
  curl -fsSL "$url" | tar xz -C "$target" --strip-components=1
  echo "python 3.12 installed to $target"
}

install_python_314() {
  local target="$INSTALLS/python/3.14"
  [ -f "$target/bin/python3.14" ] && { echo "python 3.14 already installed"; return 0; }
  mkdir -p "$target"
  # python-build-standalone 3.14 stable may not ship a matching asset yet; this is
  # the latest pre-release build at time of writing. Failure here is non-fatal.
  local url="https://github.com/astral-sh/python-build-standalone/releases/download/20250410/cpython-3.14.0a7+20250410-x86_64-unknown-linux-gnu-install_only.tar.gz"
  echo "downloading python 3.14..."
  if curl -fsSL "$url" | tar xz -C "$target" --strip-components=1; then
    [ -f "$target/bin/python3.14" ] && echo "python 3.14 installed to $target"
  else
    echo "WARNING: python 3.14 download failed (asset may not exist yet) — skipping"
    rm -rf "$target"
  fi
}

install_java_21() {
  local target="$INSTALLS/java/21"
  [ -f "$target/bin/java" ] && { echo "java 21 already installed"; return 0; }
  mkdir -p "$target"
  local url="https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.6%2B7/OpenJDK21U-jdk_x64_linux_hotspot_21.0.6_7.tar.gz"
  echo "downloading java 21..."
  curl -fsSL "$url" | tar xz -C "$target" --strip-components=1
  echo "java 21 installed to $target"
}

install_node_22
install_python_312
install_python_314
install_java_21
