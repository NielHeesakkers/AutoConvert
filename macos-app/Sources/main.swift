import AppKit
import ServiceManagement

// MARK: - Server Manager

class ServerManager {
    private var process: Process?
    private let port: Int
    private var shouldRestart = true

    init(port: Int) {
        self.port = port
    }

    var isRunning: Bool {
        process?.isRunning ?? false
    }

    func start() {
        guard !isRunning else { return }
        shouldRestart = true

        let bundle = Bundle.main
        let nodePath = bundle.path(forResource: "node", ofType: nil)
            ?? "/opt/homebrew/bin/node"
        // Use resourcePath directly — path(forResource:) can fail for directories
        let serverDir: String
        if let resourcePath = bundle.resourcePath {
            let candidate = resourcePath + "/server"
            if FileManager.default.fileExists(atPath: candidate + "/server.js") {
                serverDir = candidate
            } else {
                serverDir = ProcessInfo.processInfo.environment["PWD"] ?? "."
                NSLog("[AutoConvert] WARNING: server dir not found at %@/server, falling back to %@", resourcePath, serverDir)
            }
        } else {
            serverDir = ProcessInfo.processInfo.environment["PWD"] ?? "."
            NSLog("[AutoConvert] WARNING: no resourcePath, falling back to %@", serverDir)
        }
        let serverJS = (serverDir as NSString).appendingPathComponent("server.js")

        let appSupport = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/AutoConvert")

        // Ensure app support directories exist
        let dirs = [
            appSupport.path,
            appSupport.appendingPathComponent("reports").path,
            appSupport.appendingPathComponent("backups").path,
            appSupport.appendingPathComponent("presets").path,
        ]
        for dir in dirs {
            try? FileManager.default.createDirectory(
                atPath: dir, withIntermediateDirectories: true)
        }

        // Copy default preset if presets dir is empty (server.js handles migration too)
        let presetsDir = appSupport.appendingPathComponent("presets").path
        let presetsFiles = (try? FileManager.default.contentsOfDirectory(atPath: presetsDir).filter { $0.hasSuffix(".json") }) ?? []
        if presetsFiles.isEmpty {
            let defaultPreset = (serverDir as NSString).appendingPathComponent("scripts/Niel.json")
            let presetDest = (presetsDir as NSString).appendingPathComponent("Default Preset.json")
            if FileManager.default.fileExists(atPath: defaultPreset) {
                try? FileManager.default.copyItem(atPath: defaultPreset, toPath: presetDest)
                NSLog("[AutoConvert] Copied default preset to %@", presetDest)
            }
        }

        // Copy default config if missing
        let configDest = appSupport.appendingPathComponent("config.json").path
        if !FileManager.default.fileExists(atPath: configDest) {
            let defaultConfig: [String: Any] = [
                "recipients": [] as [Any],
                "smtp": ["host": "", "port": 587, "user": "", "password": "", "from": "", "tls": true, "starttls": true],
                "schedule": ["hour": 3, "minute": 0, "scanInterval": 0],
            ]
            if let data = try? JSONSerialization.data(withJSONObject: defaultConfig, options: .prettyPrinted) {
                try? data.write(to: URL(fileURLWithPath: configDest))
                NSLog("[AutoConvert] Created default config at %@", configDest)
            }
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = [serverJS]
        proc.currentDirectoryURL = URL(fileURLWithPath: serverDir)
        proc.environment = ProcessInfo.processInfo.environment.merging([
            "AUTOCONVERT_APP": "true",
            "PORT": String(port),
            "PATH": "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        ]) { _, new in new }

        proc.terminationHandler = { [weak self] process in
            NSLog("[AutoConvert] Server exited with code %d", process.terminationStatus)
            if self?.shouldRestart == true {
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                    NSLog("[AutoConvert] Restarting server...")
                    self?.start()
                }
            }
        }

        do {
            try proc.run()
            self.process = proc
            NSLog("[AutoConvert] Server started on port %d (PID %d)", port, proc.processIdentifier)
        } catch {
            NSLog("[AutoConvert] Failed to start server: %@", error.localizedDescription)
        }
    }

    func stop() {
        shouldRestart = false
        if let proc = process, proc.isRunning {
            proc.terminate()
            // Give it 3 seconds, then force kill
            DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
                if proc.isRunning {
                    proc.interrupt()
                }
            }
        }
        process = nil
    }
}

// MARK: - App Delegate

class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var serverManager: ServerManager!
    private let defaultPort = 3742
    private var availableVersion: String?
    private var availableChangelog: String?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let port = readPortFromConfig() ?? defaultPort
        serverManager = ServerManager(port: port)

        setupStatusBar(port: port)
        checkHandBrakeCLI()
        serverManager.start()

        // Open web UI on first launch
        let appSupport = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/AutoConvert")
        let firstLaunchFlag = appSupport.appendingPathComponent(".launched")
        if !FileManager.default.fileExists(atPath: firstLaunchFlag.path) {
            FileManager.default.createFile(atPath: firstLaunchFlag.path, contents: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                self.openWebUI(port: port)
            }
        }

        // Silent update check after 5 seconds
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
            self.checkForUpdatesInBackground()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        serverManager.stop()
    }

    // MARK: - Status Bar

    private func setupStatusBar(port: Int) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)

        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "film.stack", accessibilityDescription: "AutoConvert")
                ?? NSImage(systemSymbolName: "arrow.triangle.2.circlepath", accessibilityDescription: "AutoConvert")
        }

        let menu = NSMenu()

        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let titleItem = NSMenuItem(title: "AutoConvert v\(version)", action: nil, keyEquivalent: "")
        titleItem.isEnabled = false
        menu.addItem(titleItem)

        menu.addItem(NSMenuItem.separator())

        let updateItem = NSMenuItem(title: "Check for Updates…", action: #selector(checkForUpdates), keyEquivalent: "u")
        updateItem.target = self
        menu.addItem(updateItem)

        menu.addItem(NSMenuItem.separator())

        let openItem = NSMenuItem(title: "Open Web UI", action: #selector(openWebUIAction), keyEquivalent: "o")
        openItem.target = self
        openItem.tag = port
        menu.addItem(openItem)

        let convertItem = NSMenuItem(title: "Start Conversion", action: #selector(startConversion), keyEquivalent: "s")
        convertItem.target = self
        convertItem.tag = port
        menu.addItem(convertItem)

        menu.addItem(NSMenuItem.separator())

        let loginItem = NSMenuItem(title: "Start at Login", action: #selector(toggleLoginItem), keyEquivalent: "")
        loginItem.target = self
        loginItem.state = isLoginItemEnabled() ? .on : .off
        menu.addItem(loginItem)

        let resetItem = NSMenuItem(title: "Reset Web Password…", action: #selector(resetWebPassword), keyEquivalent: "")
        resetItem.target = self
        menu.addItem(resetItem)

        menu.addItem(NSMenuItem.separator())

        let quitItem = NSMenuItem(title: "Quit AutoConvert", action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem.menu = menu
    }

    // MARK: - Actions

    @objc private func openWebUIAction(_ sender: NSMenuItem) {
        openWebUI(port: sender.tag)
    }

    private func openWebUI(port: Int) {
        if let url = URL(string: "http://localhost:\(port)") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func startConversion(_ sender: NSMenuItem) {
        let port = sender.tag
        guard let url = URL(string: "http://localhost:\(port)/api/convert") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        URLSession.shared.dataTask(with: request) { _, _, error in
            if let error = error {
                NSLog("[AutoConvert] Start conversion failed: %@", error.localizedDescription)
            } else {
                NSLog("[AutoConvert] Conversion started")
                DispatchQueue.main.async {
                    self.openWebUI(port: port)
                }
            }
        }.resume()
    }

    @objc private func toggleLoginItem(_ sender: NSMenuItem) {
        let service = SMAppService.mainApp
        do {
            if sender.state == .on {
                try service.unregister()
                sender.state = .off
            } else {
                try service.register()
                sender.state = .on
            }
        } catch {
            NSLog("[AutoConvert] Login item toggle failed: %@", error.localizedDescription)
        }
    }

    private func checkForUpdatesInBackground() {
        let currentVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
        let updateURL = "https://raw.githubusercontent.com/NielHeesakkers/AutoConvert/main/version.json"

        let cacheBust = "\(updateURL)?t=\(Int(Date().timeIntervalSince1970))"
        guard let url = URL(string: cacheBust) else { return }
        let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let self = self,
                  let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let latestVersion = json["version"] as? String,
                  self.compareVersions(latestVersion, isNewerThan: currentVersion) else { return }

            var changeLog = ""
            if let history = json["history"] as? [[String: Any]],
               let latest = history.first,
               let changes = latest["changes"] as? [String] {
                changeLog = "\n\nWhat's new:\n• " + changes.joined(separator: "\n• ")
            }

            DispatchQueue.main.async {
                self.availableVersion = latestVersion
                self.availableChangelog = changeLog
                self.showUpdateBadge()
                self.addUpdateMenuItem(version: latestVersion)
            }
        }.resume()
    }

    private func showUpdateBadge() {
        guard let button = statusItem.button else { return }

        // Get the current base icon
        let baseImage = NSImage(systemSymbolName: "film.stack", accessibilityDescription: "AutoConvert")
            ?? NSImage(systemSymbolName: "arrow.triangle.2.circlepath", accessibilityDescription: "AutoConvert")
        guard let baseImage = baseImage else { return }

        let size = NSSize(width: 18, height: 18)
        let badgeImage = NSImage(size: size, flipped: false) { rect in
            // Draw the base icon
            baseImage.draw(in: rect)

            // Draw orange badge dot in top-right corner
            let badgeSize: CGFloat = 6
            let badgeRect = NSRect(
                x: rect.width - badgeSize - 1,
                y: rect.height - badgeSize - 1,
                width: badgeSize,
                height: badgeSize
            )
            NSColor.systemOrange.setFill()
            NSBezierPath(ovalIn: badgeRect).fill()

            return true
        }
        badgeImage.isTemplate = false
        button.image = badgeImage
    }

    private func clearUpdateBadge() {
        guard let button = statusItem.button else { return }
        let baseImage = NSImage(systemSymbolName: "film.stack", accessibilityDescription: "AutoConvert")
            ?? NSImage(systemSymbolName: "arrow.triangle.2.circlepath", accessibilityDescription: "AutoConvert")
        button.image = baseImage
    }

    private func addUpdateMenuItem(version: String) {
        guard let menu = statusItem.menu else { return }

        // Remove existing update-available item if present (tag 999)
        if let existing = menu.item(withTag: 999) {
            menu.removeItem(existing)
        }

        // Insert "Update Available" item after the version title (index 1 = separator, so insert at 2)
        let updateAvailable = NSMenuItem(title: "⬆ Update Available — v\(version)", action: #selector(downloadUpdate), keyEquivalent: "")
        updateAvailable.target = self
        updateAvailable.tag = 999

        // Add orange text attribute
        let attributes: [NSAttributedString.Key: Any] = [
            .foregroundColor: NSColor.systemOrange,
            .font: NSFont.menuFont(ofSize: 13),
        ]
        updateAvailable.attributedTitle = NSAttributedString(string: "⬆ Update Available — v\(version)", attributes: attributes)

        menu.insertItem(updateAvailable, at: 2)
    }

    @objc private func downloadUpdate() {
        guard let version = availableVersion else { return }

        let currentVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
        let changeLog = availableChangelog ?? ""

        let alert = NSAlert()
        alert.messageText = "Update Available"
        alert.informativeText = "AutoConvert v\(version) is available (you have v\(currentVersion)).\(changeLog)"
        alert.alertStyle = .informational
        alert.addButton(withTitle: "Download Update")
        alert.addButton(withTitle: "Later")
        let response = alert.runModal()
        if response == .alertFirstButtonReturn {
            self.downloadAndInstallUpdate(version: version)
        }
    }

    @objc private func checkForUpdates() {
        let currentVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
        let updateURL = "https://raw.githubusercontent.com/NielHeesakkers/AutoConvert/main/version.json"

        let cacheBust = "\(updateURL)?t=\(Int(Date().timeIntervalSince1970))"
        guard let url = URL(string: cacheBust) else { return }
        let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        URLSession.shared.dataTask(with: request) { data, _, error in
            DispatchQueue.main.async {
                if let error = error {
                    self.showUpdateAlert(title: "Update Check Failed", message: "Could not reach update server.\n\n\(error.localizedDescription)")
                    return
                }
                guard let data = data,
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let latestVersion = json["version"] as? String else {
                    self.showUpdateAlert(title: "Update Check Failed", message: "Could not read version info from server.")
                    return
                }

                if self.compareVersions(latestVersion, isNewerThan: currentVersion) {
                    // Store update info and show badge
                    var changeLog = ""
                    if let history = json["history"] as? [[String: Any]],
                       let latest = history.first,
                       let changes = latest["changes"] as? [String] {
                        changeLog = "\n\nWhat's new:\n• " + changes.joined(separator: "\n• ")
                    }

                    self.availableVersion = latestVersion
                    self.availableChangelog = changeLog
                    self.showUpdateBadge()
                    self.addUpdateMenuItem(version: latestVersion)

                    let alert = NSAlert()
                    alert.messageText = "Update Available"
                    alert.informativeText = "AutoConvert v\(latestVersion) is available (you have v\(currentVersion)).\(changeLog)"
                    alert.alertStyle = .informational
                    alert.addButton(withTitle: "Download Update")
                    alert.addButton(withTitle: "Later")
                    let response = alert.runModal()
                    if response == .alertFirstButtonReturn {
                        self.downloadAndInstallUpdate(version: latestVersion)
                    }
                } else {
                    self.availableVersion = nil
                    self.availableChangelog = nil
                    self.clearUpdateBadge()
                    // Remove update menu item if present
                    if let menu = self.statusItem.menu, let item = menu.item(withTag: 999) {
                        menu.removeItem(item)
                    }
                    self.showUpdateAlert(title: "You're Up to Date", message: "AutoConvert v\(currentVersion) is the latest version.")
                }
            }
        }.resume()
    }

    private func downloadAndInstallUpdate(version: String) {
        let dmgURL = "https://github.com/NielHeesakkers/AutoConvert/releases/download/v\(version)/AutoConvert.dmg"
        guard let url = URL(string: dmgURL) else { return }

        // Update menu to show downloading state
        if let menu = statusItem.menu, let item = menu.item(withTag: 999) {
            item.title = "\u{23F3} Downloading update..."
            item.attributedTitle = nil
            item.action = nil
        }

        let tempDir = FileManager.default.temporaryDirectory
        let dmgPath = tempDir.appendingPathComponent("AutoConvert-update.dmg")

        // Remove old temp file
        try? FileManager.default.removeItem(at: dmgPath)

        let task = URLSession.shared.downloadTask(with: url) { [weak self] tempURL, response, error in
            guard let self = self, let tempURL = tempURL, error == nil else {
                DispatchQueue.main.async {
                    self?.showUpdateAlert(title: "Update Failed", message: "Download failed: \(error?.localizedDescription ?? "Unknown error")")
                    self?.addUpdateMenuItem(version: version)
                }
                return
            }

            do {
                try FileManager.default.moveItem(at: tempURL, to: dmgPath)
            } catch {
                DispatchQueue.main.async {
                    self.showUpdateAlert(title: "Update Failed", message: "Could not save download.")
                    self.addUpdateMenuItem(version: version)
                }
                return
            }

            DispatchQueue.main.async {
                self.installUpdate(dmgPath: dmgPath)
            }
        }
        task.resume()
    }

    private func installUpdate(dmgPath: URL) {
        // Write a standalone update script that survives app termination
        let scriptPath = "/tmp/autoconvert_update.sh"
        let pid = ProcessInfo.processInfo.processIdentifier
        let script = """
        #!/bin/bash
        set -e
        # Wait for the current app to quit
        while kill -0 \(pid) 2>/dev/null; do sleep 0.5; done
        MOUNT_POINT=$(hdiutil attach "\(dmgPath.path)" -nobrowse -noverify | grep "/Volumes/" | awk -F'\\t' '{print $NF}')
        if [ -d "$MOUNT_POINT/AutoConvert.app" ]; then
            rm -rf "/Applications/AutoConvert.app"
            cp -R "$MOUNT_POINT/AutoConvert.app" "/Applications/"
            hdiutil detach "$MOUNT_POINT" -quiet
            rm -f "\(dmgPath.path)"
            open "/Applications/AutoConvert.app"
        else
            hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
        fi
        rm -f "\(scriptPath)"
        """

        do {
            try script.write(toFile: scriptPath, atomically: true, encoding: .utf8)
            // Make executable and run detached via launchd so it survives app exit
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: "/bin/bash")
            proc.arguments = ["-c", "chmod +x \(scriptPath) && nohup \(scriptPath) &>/dev/null &"]
            try proc.run()
            proc.waitUntilExit()

            // Now quit — the detached script will wait for us to die, then install & relaunch
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                self.serverManager.stop()
                NSApplication.shared.terminate(nil)
            }
        } catch {
            showUpdateAlert(title: "Update Failed", message: "Could not install update: \(error.localizedDescription)")
            if let v = availableVersion { addUpdateMenuItem(version: v) }
        }
    }

    private func compareVersions(_ v1: String, isNewerThan v2: String) -> Bool {
        let parts1 = v1.split(separator: ".").compactMap { Int($0) }
        let parts2 = v2.split(separator: ".").compactMap { Int($0) }
        let count = max(parts1.count, parts2.count)
        for i in 0..<count {
            let a = i < parts1.count ? parts1[i] : 0
            let b = i < parts2.count ? parts2[i] : 0
            if a > b { return true }
            if a < b { return false }
        }
        return false
    }

    private func showUpdateAlert(title: String, message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    @objc private func resetWebPassword() {
        let alert = NSAlert()
        alert.messageText = "Reset Web Password"
        alert.informativeText = "This will remove all users and disable authentication on the web interface. You can then set up a new account from the browser.\n\nContinue?"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Reset")
        alert.addButton(withTitle: "Cancel")
        let response = alert.runModal()
        guard response == .alertFirstButtonReturn else { return }

        let usersPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/AutoConvert/users.json")
        do {
            try "[]".write(to: usersPath, atomically: true, encoding: .utf8)
            let successAlert = NSAlert()
            successAlert.messageText = "Password Reset"
            successAlert.informativeText = "Authentication has been disabled. Open the web UI to set up a new account."
            successAlert.alertStyle = .informational
            successAlert.addButton(withTitle: "Open Web UI")
            successAlert.addButton(withTitle: "OK")
            let r = successAlert.runModal()
            if r == .alertFirstButtonReturn {
                let port = readPortFromConfig() ?? 3742
                openWebUI(port: port)
            }
        } catch {
            let errorAlert = NSAlert()
            errorAlert.messageText = "Reset Failed"
            errorAlert.informativeText = error.localizedDescription
            errorAlert.alertStyle = .critical
            errorAlert.runModal()
        }
    }

    @objc private func quitApp() {
        serverManager.stop()
        NSApplication.shared.terminate(nil)
    }

    // MARK: - Helpers

    private func isLoginItemEnabled() -> Bool {
        return SMAppService.mainApp.status == .enabled
    }

    private func readPortFromConfig() -> Int? {
        let configPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/AutoConvert/config.json")
        guard let data = try? Data(contentsOf: configPath),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let app = json["app"] as? [String: Any],
              let port = app["port"] as? Int else {
            return nil
        }
        return port
    }

    private func checkHandBrakeCLI() {
        let found = FileManager.default.fileExists(atPath: "/opt/homebrew/bin/HandBrakeCLI")
        if !found {
            DispatchQueue.main.async {
                let alert = NSAlert()
                alert.messageText = "HandBrakeCLI Not Found"
                alert.informativeText = "AutoConvert requires HandBrakeCLI for video conversion.\n\nInstall it with Homebrew:\nbrew install handbrake\n\nOr download from handbrake.fr"
                alert.alertStyle = .warning
                alert.addButton(withTitle: "OK")
                alert.runModal()
            }
        }
    }
}

// MARK: - Main

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
