#!/bin/bash
#
# gtp5g-vmlinux-setup.sh
#
# Extracts vmlinux from the running kernel image and places it where
# the gtp5g build system expects it for BTF generation.
#
# Run this after rebooting into kernel 5.15 (gtp5g-kernel-setup.sh).
# Required before compiling gtp5g with BTF support.
#
# Usage:
#   chmod +x gtp5g-vmlinux-setup.sh
#   sudo ./gtp5g-vmlinux-setup.sh
#

set -euo pipefail

KERNEL=$(uname -r)
VMLINUZ="/boot/vmlinuz-${KERNEL}"
VMLINUX_DST="/lib/modules/${KERNEL}/build/vmlinux"
EXTRACT="/usr/src/linux-headers-${KERNEL}/scripts/extract-vmlinux"

if [ -f "${VMLINUX_DST}" ]; then
    echo "vmlinux already present at ${VMLINUX_DST}. Nothing to do."
    exit 0
fi

echo "Extracting vmlinux from ${VMLINUZ}..."
"${EXTRACT}" "${VMLINUZ}" > /tmp/vmlinux

echo "Installing vmlinux to ${VMLINUX_DST}..."
cp /tmp/vmlinux "${VMLINUX_DST}"
rm -f /tmp/vmlinux

echo "Done. vmlinux ready at ${VMLINUX_DST}"
