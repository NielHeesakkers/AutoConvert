#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$SCRIPT_DIR/build"
APP_NAME="AutoConvert"
APP_BUNDLE="$BUILD_DIR/$APP_NAME.app"
NODE_VERSION="22.14.0"
NODE_ARCH="arm64"
NODE_CACHE="$SCRIPT_DIR/.node-cache"

echo "=== Building $APP_NAME.app ==="

# Clean previous build
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# --- Step 1: Compile Swift ---
echo "[1/5] Compiling Swift..."
swiftc \
    -o "$BUILD_DIR/AutoConvert" \
    "$SCRIPT_DIR/Sources/main.swift" \
    -framework AppKit \
    -framework ServiceManagement \
    -target arm64-apple-macos14.0 \
    -O

echo "  ✓ Swift binary compiled"

# --- Step 2: Download Node.js (cached) ---
NODE_TARBALL="node-v${NODE_VERSION}-darwin-${NODE_ARCH}.tar.gz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"

if [ ! -f "$NODE_CACHE/node" ]; then
    echo "[2/5] Downloading Node.js v${NODE_VERSION} (${NODE_ARCH})..."
    mkdir -p "$NODE_CACHE"
    curl -sL "$NODE_URL" | tar xz -C "$NODE_CACHE" --strip-components=2 "node-v${NODE_VERSION}-darwin-${NODE_ARCH}/bin/node"
    echo "  ✓ Node.js binary downloaded and cached"
else
    echo "[2/5] Using cached Node.js binary"
fi

# --- Step 3: Assemble .app bundle ---
echo "[3/5] Assembling app bundle..."

# Create bundle structure
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources/server"

# Copy Swift binary
cp "$BUILD_DIR/AutoConvert" "$APP_BUNDLE/Contents/MacOS/AutoConvert"

# Copy Info.plist
cp "$SCRIPT_DIR/Resources/Info.plist" "$APP_BUNDLE/Contents/"

# Copy Node.js binary
cp "$NODE_CACHE/node" "$APP_BUNDLE/Contents/Resources/node"
chmod +x "$APP_BUNDLE/Contents/Resources/node"

# Copy server files
cp "$PROJECT_DIR/server.js" "$APP_BUNDLE/Contents/Resources/server/"
cp "$PROJECT_DIR/package.json" "$APP_BUNDLE/Contents/Resources/server/"
cp "$PROJECT_DIR/package-lock.json" "$APP_BUNDLE/Contents/Resources/server/"
cp "$PROJECT_DIR/version.json" "$APP_BUNDLE/Contents/Resources/server/"
cp -r "$PROJECT_DIR/public" "$APP_BUNDLE/Contents/Resources/server/public"
cp -r "$PROJECT_DIR/scripts" "$APP_BUNDLE/Contents/Resources/server/scripts"
chmod +x "$APP_BUNDLE/Contents/Resources/server/scripts/daily_mkv_convert.sh"

# Install production dependencies
echo "  Installing node_modules..."
cd "$APP_BUNDLE/Contents/Resources/server"
npm ci --production --silent 2>/dev/null
cd "$SCRIPT_DIR"

# Copy app icon if it exists
if [ -f "$SCRIPT_DIR/Resources/AppIcon.icns" ]; then
    cp "$SCRIPT_DIR/Resources/AppIcon.icns" "$APP_BUNDLE/Contents/Resources/"
fi

echo "  ✓ App bundle assembled"

# --- Step 4: Calculate size ---
echo "[4/5] Bundle info:"
APP_SIZE=$(du -sh "$APP_BUNDLE" | awk '{print $1}')
echo "  Size: $APP_SIZE"

# --- Step 5: Create DMG ---
echo "[5/5] Creating DMG..."
DMG_PATH="$BUILD_DIR/$APP_NAME.dmg"

# Simple DMG creation (no create-dmg dependency needed)
DMG_TEMP="$BUILD_DIR/dmg-temp"
mkdir -p "$DMG_TEMP"
cp -r "$APP_BUNDLE" "$DMG_TEMP/"
ln -s /Applications "$DMG_TEMP/Applications"

hdiutil create -volname "$APP_NAME" \
    -srcfolder "$DMG_TEMP" \
    -ov -format UDZO \
    "$DMG_PATH" \
    -quiet

rm -rf "$DMG_TEMP"

DMG_SIZE=$(du -sh "$DMG_PATH" | awk '{print $1}')
echo "  ✓ DMG created: $DMG_PATH ($DMG_SIZE)"

echo ""
echo "=== Build complete ==="
echo "  App: $APP_BUNDLE"
echo "  DMG: $DMG_PATH"
