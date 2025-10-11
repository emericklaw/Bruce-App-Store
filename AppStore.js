// Import required modules for display, keyboard, file system, and WiFi functionality
var display = require("display");
var keyboard = require("keyboard");
var storage = require("storage");
var wifi = require("wifi");

// Define color palette for the OTA installer
var colours = [
    display.color(0, 0, 0),       // black - background
    display.color(127, 127, 127), // grey - UI text
    display.color(255, 255, 255), // white - values
    display.color(0, 255, 0),     // green - success
    display.color(255, 255, 0),   // yellow - warning
    display.color(255, 165, 0),   // orange - info
    display.color(255, 0, 0),     // red - error
    display.color(0, 255, 255),   // cyan - downloading
];

// Configuration
var BASE_URL = "http://ghp.iceis.co.uk/";
var RELEASES_URL = BASE_URL + "service/main/filename/releases.json";
var SCRIPTS_DIR = "/scripts/";
var VERSION_FILE = "/scripts/ota_versions.json";

// Available scripts for installation (loaded from remote releases.json)
var availableCategories = [];   // Categories from releases.json
var availableScripts = [];     // Scripts in current category
var releasesData = {};         // Full releases data from JSON
var isLoadingScripts = true;
var currentView = "categories"; // "categories" or "scripts"
var selectedCategory = "";      // Currently selected category

// Application state variables
var currentScript = 0;     // Currently selected script or category
var exitApp = false;       // Controls main application loop
var isDownloading = false; // Track download status
var statusMessage = "";    // Status message to display
var installedVersions = {}; // Track installed script versions
var statusClearTime = 0;    // Time when to clear status message
var descriptionScrollOffset = 0; // Offset for scrolling long descriptions
var lastScrollTime = 0;     // Time tracking for scroll animation
var showMenu = false;       // Whether to show the action menu
var selectedMenuOption = 0; // Currently selected menu option
var menuOptions = [];       // Available menu options for current script
var fileSystem = "littlefs"; // Default file system (will be determined at startup)

// Get display dimensions for responsive layout
var displayWidth = display.width();
var displayHeight = display.height();
var fontScale = (displayWidth > 300 ? 1 : 0);
var maxCharacters = Math.trunc(displayWidth / (6 * (fontScale + 1)));

/**
 * Detect which file system to use based on bruce.conf existence
 */
function detectFileSystem() {
    try {
        // Try to read bruce.conf from SD card first
        var confData = storage.read({ fs: "sd", path: "/bruce.conf" });
        if (confData) {
            fileSystem = "sd";
            return;
        }
    } catch (e) {
        fileSystem = "littlefs";
    }
}

/**
 * Clear status message after a delay (replaces setTimeout)
 */
function clearStatusAfterDelay() {
    statusClearTime = now() + 3000; // Clear after 3 seconds
}

/**
 * Clear status message after a shorter delay
 */
function clearStatusAfterShortDelay() {
    statusClearTime = now() + 2000; // Clear after 2 seconds
}

/**
 * Check if status message should be cleared
 */
function checkStatusClear() {
    if (statusClearTime > 0 && now() >= statusClearTime) {
        statusMessage = "";
        statusClearTime = 0;
        displayInterface();
    }
}

/**
 * Update description scrolling for long text
 */
function updateDescriptionScroll() {
    if (statusMessage || showMenu || currentView !== "scripts") return; // Don't scroll if not in script view
    var currentTime = now();
    if (currentTime - lastScrollTime > 100) { // Update every 100ms
        lastScrollTime = currentTime;
        if (availableScripts.length > 0 && !isLoadingScripts && !isDownloading) {
            var script = availableScripts[currentScript];
            if (script.metadata.description.length > maxCharacters) {
                descriptionScrollOffset++;
                if (descriptionScrollOffset > script.metadata.description.length + 10) {
                    descriptionScrollOffset = 0; // Reset scroll
                }
                // Only update the description area, not the whole screen
                updateDescriptionArea(script);
            }
        }
    }
}

/**
 * Update only the description area to prevent screen flashing
 */
function updateDescriptionArea(script) {
    // Clear only the description area
    var descY = displayHeight / 10 * 6 + ((fontScale+1) *3)-3;
    display.drawFillRect(0, descY - 10, displayWidth, 20, colours[0]); // Clear description line

    // Redraw the scrolling description
    display.setTextSize(1 + fontScale);
    display.setTextColor(colours[2]);
    display.setTextAlign('center', 'middle');

    var displayText = script.metadata.description + "    "; // Add padding
    var startPos = descriptionScrollOffset % displayText.length;
    var scrolledText = displayText.substring(startPos) + displayText.substring(0, startPos);
    var visibleText = scrolledText.substring(0, maxCharacters);
    display.setTextAlign('center', 'middle');
    display.drawText(visibleText, displayWidth / 2, descY);
}

/**
 * Reset description scroll when changing scripts
 */
function resetDescriptionScroll() {
    descriptionScrollOffset = 0;
}

// Detect file system at startup
detectFileSystem();

/**
 * Show action menu for current script
 */
function showActionMenu(script) {
    showMenu = true;
    selectedMenuOption = 0;
    menuOptions = [];

    var installedVersion = installedVersions[script.owner + '/' + script.repo];

    if (!installedVersion) {
        // Not installed
        menuOptions.push("Install");
    } else {
        // Already installed
        if (installedVersion !== script.latest_release.name) {
            menuOptions.push("Update");
        }
        menuOptions.push("Reinstall");
        menuOptions.push("Delete");
    }
    menuOptions.push("Back");

    displayInterface();
}

/**
 * Hide action menu
 */
function hideActionMenu() {
    showMenu = false;
    displayInterface();
}

/**
 * Execute selected menu action
 */
function executeMenuAction(script) {
    var action = menuOptions[selectedMenuOption];
    hideActionMenu();

    if (action === "Install" || action === "Reinstall" || action === "Update") {
        installScript(script);
    } else if (action === "Delete") {
        deleteScript(script);
    } else if (action === "Back") {

    }
}

/**
 * Delete a script
 */
function deleteScript(script) {
    try {
        // Delete all files in the script's files array
        var filesDeleted = 0;
        var files = script.metadata.files || [];

        for (var i = 0; i < files.length; i++) {
            var scriptPath = SCRIPTS_DIR + files[i];
            var deleteSuccess = storage.remove({ fs: fileSystem, path: scriptPath });
            if (deleteSuccess) {
                filesDeleted++;
            }
        }

        if (filesDeleted > 0) {
            // Remove from version tracking
            delete installedVersions[script.owner + '/' + script.repo];
            saveInstalledVersions();
            statusMessage = script.metadata.name + " deleted successfully!";
        } else {
            statusMessage = "Failed to delete script files";
        }
    } catch (e) {
        statusMessage = "Error deleting script: " + e.message;
    }

    displayInterface();
    clearStatusAfterDelay();
}

// Load installed versions
loadInstalledVersions();

// Load available scripts from remote versions.json
loadAvailableScripts();

// Show the initial interface
displayInterface();

/**
 * Load available scripts from remote versions.json
 */
function loadAvailableScripts() {
    isLoadingScripts = true;
    displayInterface();

    try {
        // Check WiFi connection first
        if (!wifi.connected()) {
            statusMessage = "WiFi not connected. Connect via WiFi menu first.";
            isLoadingScripts = false;
            displayInterface();
            return;
        }

        //statusMessage = "Fetching script list...";
        displayInterface();

        var response = wifi.httpFetch(RELEASES_URL);

        if (response.status === 200) {
            const clean = response.body
                .replace(/^\uFEFF/, '')             // remove BOM if present
                .replace(/[\u0000-\u001F\u007F-\u009F]/g, ''); // remove control chars
            const parsedData = JSON.parse(clean);

            // Check if data is categorized or flat structure
            if (Array.isArray(parsedData)) {
                // Legacy flat structure - create a single "All Scripts" category
                availableCategories = ["All Scripts"];
                releasesData = { "All Scripts": parsedData };
                currentView = "categories";
            } else {
                // New categorized structure - categories are direct properties
                availableCategories = Object.keys(parsedData);
                releasesData = parsedData;
                currentView = "categories";
            }

            // Store the full releases data for category navigation
            releasesData = releasesData;
            isLoadingScripts = false;
            //statusMessage = "Scripts loaded successfully";
        } else {
            isLoadingScripts = false;
            statusMessage = "Failed Loading Scripts (HTTP " + response.status + ")";
        }

    } catch (e) {
        isLoadingScripts = false;
        statusMessage = "Network error: " + e.message;
    }

    displayInterface();
    clearStatusAfterDelay();
}

/**
 * Load installed script versions from file
 */
function loadInstalledVersions() {
    try {
        var versionData = storage.read({ fs: fileSystem, path: VERSION_FILE });
        if (versionData) {
            installedVersions = JSON.parse(versionData);
        }
    } catch (e) {
        installedVersions = {};
    }
}

/**
 * Save installed script versions to file
 */
function saveInstalledVersions() {
    try {
        storage.write({ fs: fileSystem, path: VERSION_FILE }, JSON.stringify(installedVersions, null, 2), 'write');
    } catch (e) {
        // Ignore save errors
    }
}

/**
 * Check if script needs update
 */
function needsUpdate(script) {
    var installedVersion = installedVersions[script.owner + '/' + script.repo];
    return !installedVersion || installedVersion !== script.latest_release.name;
}

/**
 * Get status indicator for script
 */
function getScriptStatus(script) {
    var installedVersion = installedVersions[script.owner + '/' + script.repo];
    if (!installedVersion) {
        return { text: "NOT INSTALLED", color: colours[4] };
    } else if (installedVersion !== script.latest_release.name) {
        return { text: "UPDATE AVAILABLE", color: colours[5] };
    } else {
        return { text: "UP TO DATE", color: colours[3] };
    }
}

/**
 * Display the OTA installer interface
 */
function displayInterface() {

    if (!showMenu) {
        // Clear screen with black background
        display.fill(colours[0]);
        display.setTextAlign('center', 'middle');

        // Display app title
        display.setTextSize(2 + fontScale);
        display.setTextColor(BRUCE_PRICOLOR);
        display.drawText("Bruce App Store", displayWidth / 2, 7 + fontScale * 5);
    }

    if (isLoadingScripts) {
        // Show loading screen
        display.setTextSize(1 + fontScale);
        display.setTextColor(colours[7]);
        display.drawText("Loading...", displayWidth / 2, displayHeight / 2 - 10);
        display.setTextColor(colours[2]);
        display.drawText("Fetching latest versions", displayWidth / 2, displayHeight / 2 + 10);
        return;
    }

    if (isDownloading) {
        // Show downloading screen
        display.setTextSize(1 + fontScale);
        display.setTextColor(colours[7]);
        display.drawText("Downloading...", displayWidth / 2, displayHeight / 2 - 20);

        // Clear area behind status message and draw it
        display.drawFillRect(0, displayHeight / 2 + 10, displayWidth, 20, colours[0]); // Clear status area
        display.setTextColor(colours[2]);
        display.drawText(statusMessage, displayWidth / 2, displayHeight / 2 + 20);
    } else if (currentView === "categories") {
        // Show category selection
        if (availableCategories.length === 0) {
            display.setTextSize(1 + fontScale);
            display.setTextColor(colours[6]);
            display.drawText("No categories available", displayWidth / 2, displayHeight / 2 - 10);
            display.setTextColor(colours[2]);
            display.drawText("Check network connection", displayWidth / 2, displayHeight / 2 + 10);
        } else if (!showMenu) {
            // Display current category info
            display.setTextSize(1 + fontScale);
            display.setTextColor(colours[2]);
            display.drawText((currentScript + 1) + " of " + availableCategories.length,
                displayWidth / 2, displayHeight / 10 * 2);

            // Category name
            display.setTextSize(2 + fontScale);
            display.setTextColor(colours[3]);
            var categoryName = availableCategories[currentScript];
            display.drawText(categoryName, displayWidth / 2, displayHeight / 10 * 3 + 7);

            // Category description/info
            display.setTextSize(1 + fontScale);
            display.setTextColor(colours[2]);
            var categoryScripts = releasesData[categoryName] || [];
            display.drawText(categoryScripts.length + " available", displayWidth / 2, displayHeight / 2);

            // Instructions
            display.setTextColor(colours[1]);
            display.drawText("Press Select to browse", displayWidth / 2, displayHeight / 10 * 7 -10);
            display.drawText("category", displayWidth / 2, displayHeight / 10 * 8 -10);
        }
    } else if (availableScripts.length === 0) {
        // Show error if no scripts loaded in current category
        display.setTextSize(1 + fontScale);
        display.setTextColor(colours[6]);
        display.drawText("No apps in category", displayWidth / 2, displayHeight / 2 - 10);
        display.setTextColor(colours[2]);
        display.drawText("Press ESC to go back", displayWidth / 2, displayHeight / 2 + 10);
    } else if (!showMenu) {
        // Show script list
        var script = availableScripts[currentScript];
        var status = getScriptStatus(script);

        // Show category name
        if (selectedCategory) {
            display.setTextColor(colours[3]);
            display.setTextSize(1 + fontScale);
            display.drawText(selectedCategory, displayWidth / 2, displayHeight / 10 *2);
        }

        // Display current script info
        display.setTextSize(1 + fontScale);
        display.setTextColor(colours[2]);
        display.drawText((currentScript + 1) + " of " + availableScripts.length,
            displayWidth / 2, displayHeight / 10 * 3);

        // Script name
        display.setTextSize(2 + fontScale);
        display.setTextColor(colours[3]);
        display.drawText(script.metadata.name, displayWidth / 2, displayHeight / 10 *5 -5);

        // Script description
        display.setTextSize(1 + fontScale);
        display.setTextColor(colours[2]);

        // Handle scrolling for long descriptions
        if (script.metadata.description.length > maxCharacters) {
            var displayText = script.metadata.description + "    "; // Add padding
            var startPos = descriptionScrollOffset % displayText.length;
            var scrolledText = displayText.substring(startPos) + displayText.substring(0, startPos);
            var visibleText = scrolledText.substring(0, maxCharacters);

            display.setTextAlign('left', 'middle');
            display.drawText(visibleText, 0, displayHeight / 10 * 6 + ((fontScale+1) *3)-3);
        } else {
            display.setTextAlign('center', 'middle');
            display.drawText(script.metadata.description, displayHeight / 10 * 6 + ((fontScale+1) *3)-3);
        }

        // Status
        display.setTextAlign('center', 'middle');
        display.setTextColor(status.color);
        display.drawText(status.text, displayWidth / 2, displayHeight / 10 * 8 - ((fontScale+1) *3));

        // Version info
        display.setTextColor(colours[1]);
        var installedVer = installedVersions[script.owner + '/' + script.repo] || "None";
        display.drawText("Available: " + script.latest_release.name,
            displayWidth / 2, displayHeight / 10 * 9 - ((fontScale+1) *3));
        if (installedVer != 'None') {
            display.drawText("Installed: " + installedVer,
                displayWidth / 2, displayHeight / 10 * 10 - ((fontScale+1) *3));
        }
    }

    // Status message
    if (statusMessage && !isDownloading && !isLoadingScripts) {
        display.setTextSize(1 + fontScale);
        display.setTextColor(colours[5]);
        display.setTextAlign('center', 'middle');

        // Split message if longer than maxCharacters characters
        var lines = [];
        if (statusMessage.length > maxCharacters) {
            var words = statusMessage.split(' ');
            var currentLine = '';

            for (var i = 0; i < words.length; i++) {
                var testLine = currentLine + (currentLine.length > 0 ? ' ' : '') + words[i];
                if (testLine.length <= maxCharacters) {
                    currentLine = testLine;
                } else {
                    if (currentLine.length > 0) {
                        lines.push(currentLine);
                        currentLine = words[i];
                    } else {
                        // Single word longer than maxCharacters chars, just add it
                        lines.push(words[i]);
                    }
                }
            }
            if (currentLine.length > 0) {
                lines.push(currentLine);
            }
        } else {
            lines.push(statusMessage);
        }

        // Calculate box dimensions
        var boxHeight = lines.length * (fontScale + 1) * 8 + 20; // 10px padding + line spacing
        var boxWidth = Math.min(displayWidth - 20, 250); // Max width with margins
        var boxX = (displayWidth - boxWidth) / 2;
        var boxY = displayHeight / 2 - boxHeight / 2;

        // Draw box background and border
        display.drawFillRect(boxX, boxY, boxWidth, boxHeight, colours[0]); // Background
        display.drawRect(boxX, boxY, boxWidth, boxHeight, colours[5]); // Border

        // Draw each line of text
        for (var j = 0; j < lines.length; j++) {
            var textY = boxY + 10 + 8 + (j * (fontScale + 1) * 8); // 10px top padding + line spacing
            display.drawText(lines[j], displayWidth / 2, textY);
        }
    }

    // Action menu
    if (showMenu && availableScripts.length > 0) {
        var script = availableScripts[currentScript];

        // Calculate menu dimensions
        var menuHeight = menuOptions.length * 16 + 24; // 16px per option + padding
        var menuWidth = Math.min(displayWidth - 40, 200);
        var menuX = (displayWidth - menuWidth) / 2;
        var menuY = (displayHeight - menuHeight) / 2;

        // Draw menu background and border
        display.drawFillRect(menuX, menuY, menuWidth, menuHeight, colours[0]);
        display.drawRect(menuX, menuY, menuWidth, menuHeight, colours[2]);

        // Draw menu options
        display.setTextSize(1 + fontScale);
        for (var k = 0; k < menuOptions.length; k++) {
            var optionY = menuY + 16 + (k * (fontScale + 1) * 10);
            var optionColor = (k === selectedMenuOption) ? colours[3] : colours[1];
            var prefix = (k === selectedMenuOption) ? "> " : "  ";

            display.setTextColor(optionColor);
            display.setTextAlign('left', 'middle');
            display.drawText(prefix + menuOptions[k], menuX + 10, optionY);
        }
    }

    // Control instructions
    if (!isDownloading && !isLoadingScripts && availableScripts.length == 0) {
        display.setTextSize(1 + fontScale);
        display.setTextColor(colours[1]);
        display.drawText("Back: Close App", displayWidth / 2, displayHeight - 15);
    }
}

/**
 * Download and install a script
 */
function installScript(script) {
    isDownloading = true;
    statusMessage = "Connecting...";
    displayInterface();

    try {
        // Check WiFi connection
        if (!wifi.connected()) {
            statusMessage = "WiFi not connected";
            isDownloading = false;
            displayInterface();
            return;
        }

        // Create scripts directory if it doesn't exist
        try {
            storage.mkdir({ fs: fileSystem, path: SCRIPTS_DIR });
        } catch (e) {
            // Directory might already exist, ignore
        }

        statusMessage = "Downloading " + script.metadata.name + "...";
        displayInterface();

        // Download the script

        var success = 0;
        var errors = 0;
        // Get the files array
        var files = script.metadata.files;

        // Loop through the files
        for (var i = 0; i < files.length; i++) {
            console.log(files[i]);

            var url = BASE_URL + 'service/raw/owner/' + script.owner + '/repository/' + script.repo + '/tag/' + script.latest_release.tag_name + '/filename/' + files[i];
            console.log(url);
            var response = wifi.httpFetch(url);

            if (response.status === 200) {
                statusMessage = "Installing...";
                displayInterface();

                // Write the script file
                var scriptPath = SCRIPTS_DIR + files[i];
                var writeSuccess = storage.write({ fs: fileSystem, path: scriptPath }, response.body);

                if (writeSuccess) {
                    success++;
                } else {
                    statusMessage = "Failed to write script file";
                }

            } else {
                errors++;
                statusMessage = "Download failed: HTTP " + response.status;
            }
            if (success == files.length && !errors) {
                // Update version tracking
                installedVersions[script.owner + '/' + script.repo] = script.latest_release.name;
                saveInstalledVersions();
                statusMessage = script.metadata.name + " installed successfully!";
            }

        }

    } catch (e) {
        statusMessage = "Error: " + e.message;
    }

    isDownloading = false;
    displayInterface();

    // Clear status message after a delay
    clearStatusAfterDelay();
}

/**
 * Check for updates for all scripts
 */
function checkForUpdates() {
    var updatesAvailable = 0;

    for (var i = 0; i < availableScripts.length; i++) {
        if (needsUpdate(availableScripts[i])) {
            updatesAvailable++;
        }
    }

    if (updatesAvailable > 0) {
        statusMessage = updatesAvailable + " update(s) available";
    } else {
        statusMessage = "All scripts up to date";
    }

    displayInterface();

    // Clear status message after a delay
    clearStatusAfterDelay();
}

/**
 * Select a category and load its scripts
 */
function selectCategory(categoryName) {
    selectedCategory = categoryName;
    currentView = "scripts";

    if (releasesData[categoryName]) {
        availableScripts = releasesData[categoryName];
        currentScript = 0; // Reset to first script
        resetDescriptionScroll();
    } else {
        availableScripts = [];
        statusMessage = "Category not found: " + categoryName;
        clearStatusAfterDelay();
    }

    displayInterface();
}

/**
 * Go back to category selection
 */
function goBackToCategories() {
    currentView = "categories";
    currentScript = 0; // Reset selection to first category
    availableScripts = [];
    selectedCategory = "";
    resetDescriptionScroll();
    displayInterface();
}

// Main application loop
while (!exitApp) {
    // Check for exit button press (only when not in menu)
    if (keyboard.getEscPress() && !showMenu) {
        if (currentView === "scripts") {
            // Go back to categories
            goBackToCategories();
        } else {
            // Exit app
            exitApp = true;
            break;
        }
    }

    if (!isDownloading) {
        if (showMenu) {
            // Handle menu navigation
            if (keyboard.getNextPress()) {
                selectedMenuOption++;
                if (selectedMenuOption >= menuOptions.length) {
                    selectedMenuOption = 0;
                }
                displayInterface();
            }

            if (keyboard.getPrevPress()) {
                selectedMenuOption--;
                if (selectedMenuOption < 0) {
                    selectedMenuOption = menuOptions.length - 1;
                }
                displayInterface();
            }

            if (keyboard.getSelPress()) {
                var script = availableScripts[currentScript];
                executeMenuAction(script);
            }

            if (keyboard.getEscPress()) {
                hideActionMenu();
                // return; // Don't exit app, just close menu
            }
        } else if (currentView === "categories") {
            // Handle category navigation
            if (keyboard.getNextPress()) {
                if (availableCategories.length > 0) {
                    currentScript++;
                    if (currentScript >= availableCategories.length) {
                        currentScript = 0;
                    }
                    displayInterface();
                }
            }

            if (keyboard.getPrevPress()) {
                if (availableCategories.length > 0) {
                    currentScript--;
                    if (currentScript < 0) {
                        currentScript = availableCategories.length - 1;
                    }
                    displayInterface();
                }
            }

            if (keyboard.getSelPress()) {
                if (availableCategories.length > 0) {
                    var categoryName = availableCategories[currentScript];
                    selectCategory(categoryName);
                }
            }
        } else {
            // Handle script navigation
            if (keyboard.getNextPress()) {
                if (availableScripts.length > 0) {
                    currentScript++;
                    if (currentScript >= availableScripts.length) {
                        currentScript = 0;
                    }
                    resetDescriptionScroll();
                    displayInterface();
                }
            }

            if (keyboard.getPrevPress()) {
                if (availableScripts.length > 0) {
                    currentScript--;
                    if (currentScript < 0) {
                        currentScript = availableScripts.length - 1;
                    }
                    resetDescriptionScroll();
                    displayInterface();
                }
            }

            // Handle Select button press - show action menu
            if (keyboard.getSelPress()) {
                if (availableScripts.length > 0) {
                    var script = availableScripts[currentScript];
                    showActionMenu(script);
                }
            }
        }
    }

    // Check if status message should be cleared
    checkStatusClear();

    // Update description scrolling animation
    updateDescriptionScroll();

    // Small delay to prevent excessive CPU usage
    delay(50);
}
