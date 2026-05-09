#!/bin/bash
#
# gtp5g-kernel-setup.sh
#
# Downloads and installs kernel 5.15 directly from Ubuntu mainline.
# Works on any Ubuntu release regardless of distribution repos.
#
# Background: gtp5g does not compile against kernels newer than 5.15.x
# due to the removal of flowi4_tos from struct flowi4 in upstream Linux.
#
# Tested against: Ubuntu 26.04 LTS (kernel 7.0.0-15-generic)
# Target kernel:  5.15.204-0515204-generic
#
# Usage:
#   chmod +x gtp5g-kernel-setup.sh
#   sudo ./gtp5g-kernel-setup.sh
#   sudo reboot
#
# After reboot run: gtp5g-vmlinux-setup.sh
#

set -euo pipefail

KERNEL_VERSION="5.15.204-0515204"
BUILD_DATE="202604301516"
MAINLINE_URL="https://kernel.ubuntu.com/mainline/v5.15.204/amd64"
TMP_DIR=$(mktemp -d)

cleanup() {
    rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

# Check if already running a compatible kernel
if uname -r | grep -q "^5\.15"; then
    echo "Kernel $(uname -r) already active. Nothing to do."
    exit 0
fi

echo "Current kernel : $(uname -r)"
echo "Target kernel  : ${KERNEL_VERSION}-generic"
echo ""

# Download kernel packages
echo "Downloading kernel packages..."
cd "${TMP_DIR}"

wget -q --show-progress \
    "${MAINLINE_URL}/linux-headers-${KERNEL_VERSION}_${KERNEL_VERSION}.${BUILD_DATE}_all.deb" \
    "${MAINLINE_URL}/linux-headers-${KERNEL_VERSION}-generic_${KERNEL_VERSION}.${BUILD_DATE}_amd64.deb" \
    "${MAINLINE_URL}/linux-image-unsigned-${KERNEL_VERSION}-generic_${KERNEL_VERSION}.${BUILD_DATE}_amd64.deb" \
    "${MAINLINE_URL}/linux-modules-${KERNEL_VERSION}-generic_${KERNEL_VERSION}.${BUILD_DATE}_amd64.deb"

# Install packages
echo ""
echo "Installing kernel ${KERNEL_VERSION}-generic..."
dpkg -i \
    linux-headers-${KERNEL_VERSION}_${KERNEL_VERSION}.${BUILD_DATE}_all.deb \
    linux-headers-${KERNEL_VERSION}-generic_${KERNEL_VERSION}.${BUILD_DATE}_amd64.deb \
    linux-modules-${KERNEL_VERSION}-generic_${KERNEL_VERSION}.${BUILD_DATE}_amd64.deb \
    linux-image-unsigned-${KERNEL_VERSION}-generic_${KERNEL_VERSION}.${BUILD_DATE}_amd64.deb

# Pin to prevent automatic removal or upgrade
echo "Pinning kernel packages..."
apt-mark hold \
    linux-image-unsigned-${KERNEL_VERSION}-generic \
    linux-headers-${KERNEL_VERSION}-generic \
    linux-headers-${KERNEL_VERSION} \
    linux-modules-${KERNEL_VERSION}-generic

# Set as default boot entry
echo "Configuring GRUB..."
GRUB_ENTRY="Advanced options for Ubuntu>Ubuntu, with Linux ${KERNEL_VERSION}-generic"
sed -i "s/^GRUB_DEFAULT=.*/GRUB_DEFAULT=\"${GRUB_ENTRY}\"/" /etc/default/grub
update-grub

echo ""
echo "Done. Reboot and verify with: uname -r"
echo "Expected output: ${KERNEL_VERSION}-generic"
echo "Then run: gtp5g-vmlinux-setup.sh"
