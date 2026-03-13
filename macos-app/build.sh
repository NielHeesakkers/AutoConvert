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

# Code signing & notarization
SIGN_IDENTITY="Developer ID Application: Niel Heesakkers (DE59N86W33)"
KEYCHAIN_PROFILE="AC_PASSWORD"
BUNDLE_ID="com.niel.autoconvert"

echo "=== Building $APP_NAME.app ==="

# Clean previous build
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# --- Step 1: Compile Swift ---
echo "[1/7] Compiling Swift..."
swiftc \
    -o "$BUILD_DIR/AutoConvert" \
    "$SCRIPT_DIR/Sources/main.swift" \
    -framework AppKit \
    -framework ServiceManagement \
    -target arm64-apple-macos14.0 \
    -O \
    -Xlinker -rpath -Xlinker @executable_path/../Frameworks

echo "  ✓ Swift binary compiled"

# --- Step 2: Download Node.js (cached) ---
NODE_TARBALL="node-v${NODE_VERSION}-darwin-${NODE_ARCH}.tar.gz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"

if [ ! -f "$NODE_CACHE/node" ]; then
    echo "[2/7] Downloading Node.js v${NODE_VERSION} (${NODE_ARCH})..."
    mkdir -p "$NODE_CACHE"
    curl -sL "$NODE_URL" | tar xz -C "$NODE_CACHE" --strip-components=2 "node-v${NODE_VERSION}-darwin-${NODE_ARCH}/bin/node"
    echo "  ✓ Node.js binary downloaded and cached"
else
    echo "[2/7] Using cached Node.js binary"
fi

# --- Step 3: Assemble .app bundle ---
echo "[3/7] Assembling app bundle..."

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

# Bundle HandBrakeCLI + its dylib dependencies
echo "  Bundling HandBrakeCLI..."
HB_BIN=$(realpath /opt/homebrew/bin/HandBrakeCLI 2>/dev/null || echo "/opt/homebrew/bin/HandBrakeCLI")
if [ -f "$HB_BIN" ]; then
    FRAMEWORKS_DIR="$APP_BUNDLE/Contents/Frameworks"
    mkdir -p "$FRAMEWORKS_DIR"
    cp "$HB_BIN" "$APP_BUNDLE/Contents/Resources/HandBrakeCLI"
    chmod +x "$APP_BUNDLE/Contents/Resources/HandBrakeCLI"

    # Copy all Homebrew dylibs and rewrite their paths
    otool -L "$HB_BIN" | grep '/opt/homebrew.*\.dylib' | awk '{print $1}' | while read -r dylib; do
        DYLIB_REAL=$(realpath "$dylib" 2>/dev/null || echo "$dylib")
        DYLIB_NAME=$(basename "$dylib")
        cp "$DYLIB_REAL" "$FRAMEWORKS_DIR/$DYLIB_NAME"
        chmod 644 "$FRAMEWORKS_DIR/$DYLIB_NAME"
        # Rewrite the HandBrakeCLI reference to use @rpath
        install_name_tool -change "$dylib" "@rpath/$DYLIB_NAME" "$APP_BUNDLE/Contents/Resources/HandBrakeCLI"
    done

    # Recursively resolve transitive dylib dependencies until no new ones are found
    PASS=0
    while true; do
        PASS=$((PASS + 1))
        NEW_DEPS=0
        for fw_dylib in "$FRAMEWORKS_DIR"/*.dylib; do
            otool -L "$fw_dylib" | grep '/opt/homebrew.*\.dylib' | awk '{print $1}' | while read -r dep; do
                DEP_REAL=$(realpath "$dep" 2>/dev/null || echo "$dep")
                DEP_NAME=$(basename "$dep")
                if [ ! -f "$FRAMEWORKS_DIR/$DEP_NAME" ]; then
                    cp "$DEP_REAL" "$FRAMEWORKS_DIR/$DEP_NAME"
                    chmod 644 "$FRAMEWORKS_DIR/$DEP_NAME"
                    echo "NEW" >> /tmp/hb_new_deps.txt
                fi
                install_name_tool -change "$dep" "@rpath/$DEP_NAME" "$fw_dylib"
            done
            # Set the dylib's own id
            install_name_tool -id "@rpath/$(basename "$fw_dylib")" "$fw_dylib"
        done
        if [ -f /tmp/hb_new_deps.txt ]; then
            NEW_COUNT=$(wc -l < /tmp/hb_new_deps.txt | tr -d ' ')
            rm -f /tmp/hb_new_deps.txt
            [ "$NEW_COUNT" -eq 0 ] && break
        else
            break
        fi
        # Safety: max 10 passes
        [ "$PASS" -ge 10 ] && break
    done

    # Add rpath to HandBrakeCLI
    install_name_tool -add_rpath "@executable_path/../Frameworks" "$APP_BUNDLE/Contents/Resources/HandBrakeCLI" 2>/dev/null || true

    HB_DYLIB_COUNT=$(ls "$FRAMEWORKS_DIR"/*.dylib 2>/dev/null | wc -l | tr -d ' ')
    echo "  ✓ HandBrakeCLI bundled with $HB_DYLIB_COUNT dylibs"
else
    echo "  ⚠ HandBrakeCLI not found — skipping bundle"
fi

# Remove node_modules/.bin symlinks (breaks code signing sealed resources)
rm -rf "$APP_BUNDLE/Contents/Resources/server/node_modules/.bin"

# Remove any other problematic symlinks in node_modules
find "$APP_BUNDLE/Contents/Resources/server/node_modules" -type l -delete 2>/dev/null || true

echo "  ✓ App bundle assembled"

# --- Step 4: Calculate size ---
echo "[4/7] Bundle info:"
APP_SIZE=$(du -sh "$APP_BUNDLE" | awk '{print $1}')
echo "  Size: $APP_SIZE"

# --- Step 5: Code sign ---
echo "[5/7] Code signing..."

ENTITLEMENTS="$SCRIPT_DIR/Resources/AutoConvert.entitlements"

# Sign all Frameworks dylibs (HandBrakeCLI dependencies)
find "$APP_BUNDLE/Contents/Frameworks" -name "*.dylib" -type f 2>/dev/null | while read -r lib; do
    codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$lib"
done
FWCOUNT=$(find "$APP_BUNDLE/Contents/Frameworks" -name "*.dylib" -type f 2>/dev/null | wc -l | tr -d ' ')
[ "$FWCOUNT" -gt 0 ] && echo "  ✓ Signed $FWCOUNT framework dylibs"

# Sign HandBrakeCLI
if [ -f "$APP_BUNDLE/Contents/Resources/HandBrakeCLI" ]; then
    codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" \
        --entitlements "$ENTITLEMENTS" \
        "$APP_BUNDLE/Contents/Resources/HandBrakeCLI"
    echo "  ✓ HandBrakeCLI signed"
fi

# Sign all .dylib files in node_modules (inside-out)
find "$APP_BUNDLE/Contents/Resources/server/node_modules" -name "*.dylib" -type f 2>/dev/null | while read -r lib; do
    codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$lib"
    echo "  ✓ Signed: $(basename "$lib")"
done

# Sign any .node native modules
find "$APP_BUNDLE/Contents/Resources/server/node_modules" -name "*.node" -type f 2>/dev/null | while read -r mod; do
    codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$mod"
    echo "  ✓ Signed: $(basename "$mod")"
done

# Sign the Node.js binary (embedded executable)
codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" \
    --entitlements "$ENTITLEMENTS" \
    "$APP_BUNDLE/Contents/Resources/node"
echo "  ✓ Node.js binary signed"

# Sign the main executable
codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" \
    --entitlements "$ENTITLEMENTS" \
    "$APP_BUNDLE/Contents/MacOS/AutoConvert"
echo "  ✓ Main binary signed"

# Sign the entire app bundle
codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" \
    --entitlements "$ENTITLEMENTS" \
    "$APP_BUNDLE"
echo "  ✓ App bundle signed"

# Verify signature
codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE" 2>&1 | tail -5
echo "  ✓ Signature verified"

# Verify with spctl (Gatekeeper check)
spctl --assess --type execute --verbose "$APP_BUNDLE" 2>&1 || echo "  (spctl check — will pass after notarization)"

# --- Step 6: Create DMG ---
echo "[6/7] Creating DMG..."
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

# Sign the DMG too
codesign --force --sign "$SIGN_IDENTITY" "$DMG_PATH"

DMG_SIZE=$(du -sh "$DMG_PATH" | awk '{print $1}')
echo "  ✓ DMG created: $DMG_PATH ($DMG_SIZE)"

# --- Step 7: Notarize ---
echo "[7/7] Notarizing (this may take a few minutes)..."

xcrun notarytool submit "$DMG_PATH" \
    --keychain-profile "$KEYCHAIN_PROFILE" \
    --wait 2>&1 | tee "$BUILD_DIR/notarize.log"

# Check if notarization succeeded
if grep -q "status: Accepted" "$BUILD_DIR/notarize.log"; then
    echo "  ✓ Notarization accepted"

    # Staple the ticket to the DMG
    xcrun stapler staple "$DMG_PATH"
    echo "  ✓ Ticket stapled to DMG"
else
    echo "  ⚠ Notarization may have failed — check notarize.log"
    echo "  You can check status with: xcrun notarytool log <submission-id> --keychain-profile $KEYCHAIN_PROFILE"
fi

echo ""
echo "=== Build complete ==="
echo "  App: $APP_BUNDLE"
echo "  DMG: $DMG_PATH"
