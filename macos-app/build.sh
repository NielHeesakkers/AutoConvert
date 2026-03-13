#!/bin/bash
set -eo pipefail

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

# Cleanup temp files on exit
trap 'rm -f "$BUILD_DIR"/.new_deps_*.txt' EXIT

# --- Shared function: bundle a native binary with its dylib dependencies ---
bundle_binary() {
    local BIN_PATH="$1"
    local DEST_NAME="$2"
    local FW_DIR="$APP_BUNDLE/Contents/Frameworks"
    mkdir -p "$FW_DIR"

    cp "$BIN_PATH" "$APP_BUNDLE/Contents/Resources/$DEST_NAME"
    chmod +x "$APP_BUNDLE/Contents/Resources/$DEST_NAME"

    # Copy direct Homebrew dylibs and rewrite paths
    while IFS= read -r dylib; do
        local DYLIB_REAL
        DYLIB_REAL=$(realpath "$dylib" 2>/dev/null || echo "$dylib")
        local DYLIB_NAME
        DYLIB_NAME=$(basename "$dylib")
        if [ ! -f "$FW_DIR/$DYLIB_NAME" ]; then
            cp "$DYLIB_REAL" "$FW_DIR/$DYLIB_NAME"
            chmod 644 "$FW_DIR/$DYLIB_NAME"
        fi
        install_name_tool -change "$dylib" "@rpath/$DYLIB_NAME" "$APP_BUNDLE/Contents/Resources/$DEST_NAME"
    done < <(otool -L "$BIN_PATH" | grep '/opt/homebrew.*\.dylib' | awk '{print $1}')

    # Recursively resolve transitive dependencies (max 10 passes)
    local PASS=0
    while [ "$PASS" -lt 10 ]; do
        PASS=$((PASS + 1))
        local DEP_FLAG="$BUILD_DIR/.new_deps_${DEST_NAME}.txt"
        rm -f "$DEP_FLAG"

        for fw_dylib in "$FW_DIR"/*.dylib; do
            [ -f "$fw_dylib" ] || continue
            while IFS= read -r dep; do
                local DEP_REAL
                DEP_REAL=$(realpath "$dep" 2>/dev/null || echo "$dep")
                local DEP_NAME
                DEP_NAME=$(basename "$dep")
                if [ ! -f "$FW_DIR/$DEP_NAME" ]; then
                    cp "$DEP_REAL" "$FW_DIR/$DEP_NAME"
                    chmod 644 "$FW_DIR/$DEP_NAME"
                    echo "1" >> "$DEP_FLAG"
                fi
                install_name_tool -change "$dep" "@rpath/$DEP_NAME" "$fw_dylib"
            done < <(otool -L "$fw_dylib" | grep '/opt/homebrew.*\.dylib' | awk '{print $1}')
            install_name_tool -id "@rpath/$(basename "$fw_dylib")" "$fw_dylib"
        done

        [ -f "$DEP_FLAG" ] || break
    done

    install_name_tool -add_rpath "@executable_path/../Frameworks" \
        "$APP_BUNDLE/Contents/Resources/$DEST_NAME" 2>/dev/null || true
}

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
cp -r "$PROJECT_DIR/lib" "$APP_BUNDLE/Contents/Resources/server/lib"
cp -r "$PROJECT_DIR/routes" "$APP_BUNDLE/Contents/Resources/server/routes"
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
    bundle_binary "$HB_BIN" "HandBrakeCLI"
    HB_DYLIB_COUNT=$(find "$APP_BUNDLE/Contents/Frameworks" -name "*.dylib" -type f 2>/dev/null | wc -l | tr -d ' ')
    echo "  ✓ HandBrakeCLI bundled with $HB_DYLIB_COUNT dylibs"
else
    echo "  ⚠ HandBrakeCLI not found — skipping bundle"
fi

# Bundle msmtp + its dylib dependencies
echo "  Bundling msmtp..."
MSMTP_BIN=$(realpath /opt/homebrew/bin/msmtp 2>/dev/null || echo "/opt/homebrew/bin/msmtp")
if [ -f "$MSMTP_BIN" ]; then
    bundle_binary "$MSMTP_BIN" "msmtp"
    echo "  ✓ msmtp bundled"
else
    echo "  ⚠ msmtp not found — skipping bundle"
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

# Sign all Frameworks dylibs
FWCOUNT=$(find "$APP_BUNDLE/Contents/Frameworks" -name "*.dylib" -type f 2>/dev/null | wc -l | tr -d ' ')
if [ "$FWCOUNT" -gt 0 ]; then
    while IFS= read -r lib; do
        codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$lib"
    done < <(find "$APP_BUNDLE/Contents/Frameworks" -name "*.dylib" -type f)
    echo "  ✓ Signed $FWCOUNT framework dylibs"
fi

# Sign HandBrakeCLI
if [ -f "$APP_BUNDLE/Contents/Resources/HandBrakeCLI" ]; then
    codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" \
        --entitlements "$ENTITLEMENTS" \
        "$APP_BUNDLE/Contents/Resources/HandBrakeCLI"
    echo "  ✓ HandBrakeCLI signed"
fi

# Sign msmtp
if [ -f "$APP_BUNDLE/Contents/Resources/msmtp" ]; then
    codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" \
        --entitlements "$ENTITLEMENTS" \
        "$APP_BUNDLE/Contents/Resources/msmtp"
    echo "  ✓ msmtp signed"
fi

# Sign all .dylib files in node_modules (inside-out)
while IFS= read -r lib; do
    codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$lib"
    echo "  ✓ Signed: $(basename "$lib")"
done < <(find "$APP_BUNDLE/Contents/Resources/server/node_modules" -name "*.dylib" -type f 2>/dev/null)

# Sign any .node native modules
while IFS= read -r mod; do
    codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$mod"
    echo "  ✓ Signed: $(basename "$mod")"
done < <(find "$APP_BUNDLE/Contents/Resources/server/node_modules" -name "*.node" -type f 2>/dev/null)

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
