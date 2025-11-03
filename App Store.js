var display = require("display");
var keyboard = require("keyboard");
var storage = require("storage");
var wifi = require("wifi");

// Color palette
var colours = [
    display.color(0, 0, 0),       // 0: black
    display.color(127, 127, 127), // 1: grey
    display.color(255, 255, 255), // 2: white
    display.color(0, 255, 0),     // 3: green
    display.color(255, 255, 0),   // 4: yellow
    display.color(255, 165, 0),   // 5: orange
    display.color(255, 0, 0),     // 6: red
    display.color(0, 255, 255),   // 7: cyan
];

// Configuration constants
var BASE_URL = "http://ghp.iceis.co.uk/";
var RELEASES_URL = BASE_URL + "service/main/filename/releases.json";
var SCRIPTS_DIR = "/scripts/", THEMES_DIR = "/Themes/";
var VERSION_FILE = "/BruceAppStore/installed.json";

// Data storage
var availableCategories = [], availableScripts = [], releasesData = {}, installedVersions = {};

// Application state
var currentScript = 0, lastCategoryIndex = 0, selectedMenuOption = 0;
var currentView = "categories", selectedCategory = "";
var exitApp = false, isLoadingScripts = true, isDownloading = false, showMenu = false;
var statusMessage = "", statusClearTime = 0;
var descriptionScrollOffset = 0, lastScrollTime = 0;
var menuOptions = [], fileSystem = "littlefs";

// Display configuration
var displayWidth = display.width(), displayHeight = display.height();
var fontScale = displayWidth > 300 ? 1 : 0;
var maxCharacters = Math.trunc(displayWidth / (6 * (fontScale + 1)));

/**
 * Detect which file system to use based on bruce.conf existence
 */
function detectFileSystem() {
    try {
        var confData = storage.read({ fs: "sd", path: "/bruce.conf" });
        fileSystem = confData ? "sd" : "littlefs";
    } catch (e) {
        fileSystem = "littlefs";
    }
}

/**
 * Clear status message after a delay
 */
function clearStatusAfterDelay() {
    statusClearTime = now() + 3000;
}

/**
 * Check and clear status message if time expired
 */
function checkStatusClear() {
    if (statusClearTime > 0 && now() >= statusClearTime) {
        statusMessage = statusClearTime = "";
        displayInterface();
    }
}

/**
 * Update description scrolling for long text
 */
function updateDescriptionScroll() {
    if (statusMessage || showMenu || currentView !== "scripts" ||
        availableScripts.length === 0 || isLoadingScripts || isDownloading ||
        now() - lastScrollTime <= 100) {
        return;
    }

    lastScrollTime = now();
    var script = availableScripts[currentScript];

    if (script.description.length > maxCharacters) {
        descriptionScrollOffset = ++descriptionScrollOffset > script.description.length + 10 ? 0 : descriptionScrollOffset;
        updateDescriptionArea(script);
    }
}

/**
 * Update only the description area to prevent screen flashing
 */
function updateDescriptionArea(script) {
    var descY = displayHeight / 10 * 6 + ((fontScale + 1) * 3) - 3;

    // Clear and setup display
    display.drawFillRect(0, descY - 10, displayWidth, 20, colours[0]);
    display.setTextSize(1 + fontScale);
    display.setTextColor(colours[2]);
    display.setTextAlign('center', 'middle');

    // Create and display scrolling text
    var paddedText = script.description + "    ";
    var startPos = descriptionScrollOffset % paddedText.length;
    display.drawText((paddedText + paddedText).substring(startPos, startPos + maxCharacters),
        displayWidth / 2, descY);
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

    var installedVersion = installedVersions[script.owner + '/' + script.repo + ':' + script.name];
    var isInstalled = !!installedVersion;
    var hasUpdate = isInstalled && installedVersion !== script.version;

    menuOptions = isInstalled
        ? (hasUpdate ? ["Update", "Reinstall", "Delete"] : ["Reinstall", "Delete"])
        : ["Install"];

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

    if (["Install", "Reinstall", "Update"].indexOf(action) !== -1) {
        installScript(script);
    } else if (action === "Delete") {
        deleteScript(script);
    }
}

/**
 * Delete a script
 */
function deleteScript(script) {
    try {
        var fullMetadata = loadFullMetadata(script.metadata_file);
        var files = fullMetadata.files || [];
        var baseDir = (script.category === 'Themes') ? THEMES_DIR : SCRIPTS_DIR;
        var deletedAny = false;

        for (var i = 0; i < files.length; i++) {
            var filePath = baseDir + files[i].destination.replace(/^\/+/, '');
            console.log("Deleting: " + filePath);

            if (storage.remove({ fs: fileSystem, path: filePath })) {
                deletedAny = true;
            }
        }

        if (deletedAny) {
            delete installedVersions[script.owner + '/' + script.repo + ':' + script.name];
            saveInstalledVersions();
            statusMessage = script.name + " deleted successfully!";
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
 * Load available scripts from remote releases.json
 */
function loadAvailableScripts() {
    isLoadingScripts = true;
    displayInterface();

    try {
        if (!wifi.connected()) {
            statusMessage = "WiFi not connected. Connect via WiFi menu first.";
            isLoadingScripts = false;
            displayInterface();
            return;
        }

        var response = wifi.httpFetch(RELEASES_URL);

        if (response.status === 200) {
            var clean = response.body
                .replace(/^\uFEFF/, '')
                .replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
            var parsedData = JSON.parse(clean);

            availableCategories = Object.keys(parsedData);
            releasesData = parsedData;

            currentView = "categories";
            createUpdatesCategory();
        } else {
            statusMessage = "Failed Loading Scripts (HTTP " + response.status + ")";
        }

    } catch (e) {
        statusMessage = "Network error: " + e.message;
    }

    isLoadingScripts = false;
    displayInterface();
    clearStatusAfterDelay();
}


function loadFullMetadata(metadataURL) {
    try {
        var response = wifi.httpFetch(BASE_URL + 'service/main/filename-last/' + metadataURL);
        if (response.status === 200) {
            return JSON.parse(response.body
                .replace(/^\uFEFF/, '')
                .replace(/[\u0000-\u001F\u007F-\u009F]/g, ''));
        }
        statusMessage = "Failed Loading Metadata (HTTP " + response.status + ")";
    } catch (e) {
        statusMessage = "Network error: " + e.message;
    }
}

/**
 * Load installed script versions from file
 */
function loadInstalledVersions() {
    try {
        var versionData = storage.read({ fs: fileSystem, path: VERSION_FILE });
        installedVersions = versionData ? JSON.parse(versionData) : {};
    } catch (e) {
        installedVersions = {};
    }

    if (!installedVersions["emericklaw/Bruce-App-Store:App Store"]) {
        installedVersions["emericklaw/Bruce-App-Store:App Store"] = "0.0.0";
        saveInstalledVersions();
    }
}

/**
 * Save installed script versions to file and refresh Updates category
 */
function saveInstalledVersions() {
    try {
        storage.write({ fs: fileSystem, path: VERSION_FILE }, JSON.stringify(installedVersions, null, 2), "write");
        if (!isLoadingScripts && releasesData) {
            createUpdatesCategory();
        }
    } catch (e) {
        // Ignore save errors
    }
}

/**
 * Check if script needs update
 */
function needsUpdate(script) {
    var installedVersion = installedVersions[script.owner + '/' + script.repo + ':' + script.name];
    return installedVersion !== script.version;
}

/**
 * Get status indicator for script
 */
function getScriptStatus(script) {
    var installedVersion = installedVersions[script.owner + '/' + script.repo + ':' + script.name];
    if (!installedVersion) return { text: "NOT INSTALLED", color: colours[4] };
    if (installedVersion !== script.version) return { text: "UPDATE AVAILABLE", color: colours[5] };
    return { text: "UP TO DATE", color: colours[3] };
}

/**
 * Helper function to split text into lines that fit within maxCharacters
 */
function splitTextIntoLines(text) {
    if (text.length <= maxCharacters) return [text];

    var lines = [], words = text.split(' '), currentLine = '';

    for (var i = 0; i < words.length; i++) {
        var testLine = currentLine + (currentLine.length > 0 ? ' ' : '') + words[i];
        if (testLine.length <= maxCharacters) {
            currentLine = testLine;
        } else {
            if (currentLine.length > 0) {
                lines.push(currentLine);
                currentLine = words[i];
            } else {
                lines.push(words[i]);
            }
        }
    }
    if (currentLine.length > 0) lines.push(currentLine);
    return lines;
}

/**
 * Draw status message with background box
 */
function drawStatusMessage() {
    if (!statusMessage || isDownloading || isLoadingScripts) return;

    display.setTextSize(1 + fontScale);
    display.setTextColor(colours[5]);
    display.setTextAlign('center', 'middle');

    var lines = splitTextIntoLines(statusMessage);
    var boxHeight = lines.length * (fontScale + 1) * 8 + 20;
    var boxWidth = Math.min(displayWidth - 20, 250);
    var boxX = (displayWidth - boxWidth) / 2;
    var boxY = displayHeight / 2 - boxHeight / 2;

    // Draw box background and border
    display.drawFillRect(boxX, boxY, boxWidth, boxHeight, colours[0]);
    display.drawRect(boxX, boxY, boxWidth, boxHeight, colours[5]);

    // Draw text lines
    for (var i = 0; i < lines.length; i++) {
        var textY = boxY + 18 + (i * (fontScale + 1) * 8);
        display.drawText(lines[i], displayWidth / 2, textY);
    }
}

/**
 * Draw action menu
 */
function drawActionMenu() {
    if (!showMenu || availableScripts.length === 0) return;

    var menuHeight = menuOptions.length * 16 + 24;
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

/**
 * Draw category view
 */
function drawCategoryView() {
    if (availableCategories.length === 0) {
        display.setTextSize(1 + fontScale);
        display.setTextColor(colours[6]);
        display.drawText("No categories available", displayWidth / 2, displayHeight / 2 - 10);
        display.setTextColor(colours[2]);
        display.drawText("Check network connection", displayWidth / 2, displayHeight / 2 + 10);
        return;
    }

    if (showMenu) return;

    var categoryName = availableCategories[currentScript];
    var categoryScripts = releasesData[categoryName] || [];

    // Display current category info
    display.setTextSize(1 + fontScale);
    display.setTextColor(colours[2]);
    display.drawText((currentScript + 1) + " of " + availableCategories.length,
        displayWidth / 2, displayHeight / 10 * 2);

    // Category name with special styling for Updates
    display.setTextSize(2 + fontScale);
    display.setTextColor(categoryName === "Updates" ? colours[5] : colours[3]);
    var nameText = categoryName === "Updates" ? "* " + categoryName + " *" : categoryName;
    display.drawText(nameText, displayWidth / 2, displayHeight / 10 * 3 + 7);

    // Category description
    display.setTextSize(1 + fontScale);
    display.setTextColor(colours[2]);
    var descText = categoryName === "Updates"
        ? categoryScripts.length + " update" + (categoryScripts.length === 1 ? "" : "s") + " available"
        : categoryScripts.length + " available";
    display.drawText(descText, displayWidth / 2, displayHeight / 2);

    // Instructions
    display.setTextColor(colours[1]);
    display.drawText("Press Select to browse", displayWidth / 2, displayHeight / 10 * 7 - 10);
    display.drawText("category", displayWidth / 2, displayHeight / 10 * 8 - 10);
}

/**
 * Draw script view
 */
function drawScriptView() {
    if (availableScripts.length === 0) {
        display.setTextSize(1 + fontScale);
        display.setTextColor(colours[6]);
        display.drawText("No apps in category", displayWidth / 2, displayHeight / 2 - 10);
        display.setTextColor(colours[2]);
        display.drawText("Press ESC to go back", displayWidth / 2, displayHeight / 2 + 10);
        return;
    }

    if (showMenu) return;

    var script = availableScripts[currentScript];
    var status = getScriptStatus(script);

    // Show category name
    if (selectedCategory) {
        display.setTextColor(colours[3]);
        display.setTextSize(1 + fontScale);
        display.drawText(selectedCategory, displayWidth / 2, displayHeight / 10 * 2);
    }

    // Display current script info
    display.setTextSize(1 + fontScale);
    display.setTextColor(colours[2]);
    display.drawText((currentScript + 1) + " of " + availableScripts.length,
        displayWidth / 2, displayHeight / 10 * 3);

    // Script name
    display.setTextSize(2 + fontScale);
    display.setTextColor(colours[3]);
    display.drawText(script.name, displayWidth / 2, displayHeight / 10 * 5 - 5);

    // Script description (with scrolling support)
    display.setTextSize(1 + fontScale);
    display.setTextColor(colours[2]);
    var descY = displayHeight / 10 * 6 + ((fontScale + 1) * 3) - 3;

    if (script.description.length > maxCharacters) {
        var displayText = script.description + "    ";
        var startPos = descriptionScrollOffset % displayText.length;
        var scrolledText = displayText.substring(startPos) + displayText.substring(0, startPos);
        var visibleText = scrolledText.substring(0, maxCharacters);
        display.setTextAlign('left', 'middle');
        display.drawText(visibleText, 0, descY);
    } else {
        display.setTextAlign('center', 'middle');
        display.drawText(script.description, displayWidth / 2, descY);
    }

    // Status and version info
    display.setTextAlign('center', 'middle');
    display.setTextColor(status.color);
    display.drawText(status.text, displayWidth / 2, displayHeight / 10 * 8 - ((fontScale + 1) * 3));

    display.setTextColor(colours[1]);
    if (script.version !== 'UNKNOWN') {
        var installedVer = installedVersions[script.owner + '/' + script.repo + ':' + script.name] || "None";
        display.drawText("Available: " + script.version,
            displayWidth / 2, displayHeight / 10 * 9 - ((fontScale + 1) * 3));
        if (installedVer !== 'None') {
            display.drawText("Installed: " + installedVer,
                displayWidth / 2, displayHeight / 10 * 10 - ((fontScale + 1) * 3));
        }
    }
}

/**
 * Display the App Store interface
 */
function displayInterface() {
    if (!showMenu) {
        display.fill(colours[0]);
        display.setTextAlign('center', 'middle');
        display.setTextSize(2 + fontScale);
        display.setTextColor(BRUCE_PRICOLOR);
        display.drawText("Bruce App Store", displayWidth / 2, 7 + fontScale * 5);
    }

    if (isLoadingScripts) {
        display.setTextSize(1 + fontScale);
        display.setTextColor(colours[7]);
        display.drawText("Loading...", displayWidth / 2, displayHeight / 2 - 10);
        display.setTextColor(colours[2]);
        display.drawText("Fetching latest versions", displayWidth / 2, displayHeight / 2 + 10);
        return;
    }

    if (isDownloading) {
        display.setTextSize(1 + fontScale);
        display.setTextColor(colours[7]);
        display.drawText("Downloading...", displayWidth / 2, displayHeight / 2 - 20);
        display.drawFillRect(0, displayHeight / 2 + 10, displayWidth, 20, colours[0]);
        display.setTextColor(colours[2]);
        display.drawText(statusMessage, displayWidth / 2, displayHeight / 2 + 20);
        return;
    }

    if (currentView === "categories") {
        drawCategoryView();
    } else {
        drawScriptView();
    }

    drawStatusMessage();
    drawActionMenu();

    // Control instructions
    if (!isDownloading && !isLoadingScripts && availableScripts.length === 0) {
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

        statusMessage = "Downloading " + script.name + "...";
        displayInterface();

        var success = 0;
        var errors = 0;

        // Download full metadata
        var fullMetadata = loadFullMetadata(script.metadata_file);
        var files = fullMetadata.files;
        var baseLocalDir = (script.category === 'Themes') ? THEMES_DIR : SCRIPTS_DIR;

        // Loop through the files
        for (var i = 0; i < files.length; i++) {
            var file = files[i];
            var destPath = baseLocalDir + file.destination.replace(/^\/+/, '');

            console.log("Downloading: " + file.source + " -> " + destPath);

            var url = script.version === 'UNKNOWN'
                ? BASE_URL + 'service/manual/owner/' + script.owner + '/repository/' + script.repo + '/filename-last/' + file.source
                : BASE_URL + 'service/release/owner/' + script.owner + '/repository/' + script.repo + '/tag/' + fullMetadata.tag + '/filename-last/' + file.source;

            var response = wifi.httpFetch(url);

            if (response.status === 200) {
                statusMessage = "Downloading " + (i + 1) + " of " + files.length + "...";
                displayInterface();

                if (storage.write({ fs: fileSystem, path: destPath }, response.body, "write")) {
                    success++;
                } else {
                    statusMessage = "Failed to write file: " + destPath;
                    errors++;
                }
            } else {
                errors++;
                statusMessage = "Download failed: HTTP " + response.status + " for " + file.source;
            }
        }

        // Check if all files were downloaded successfully
        if (success === files.length && errors === 0) {
            installedVersions[script.owner + '/' + script.repo + ':' + script.name] = script.version;
            saveInstalledVersions();
            statusMessage = script.name + " installed successfully!";
        }

    } catch (e) {
        statusMessage = "Error: " + e.message;
    }

    isDownloading = false;
    displayInterface();
    clearStatusAfterDelay();
}

/**
 * Create an "Updates" category containing apps with available updates
 */
function createUpdatesCategory() {
    var updatesAvailable = [];

    // Go through all categories and scripts to find apps with updates
    for (var categoryName in releasesData) {
        if (categoryName === "Updates") continue;

        var scripts = releasesData[categoryName];
        for (var i = 0; i < scripts.length; i++) {
            var script = scripts[i];
            var installedVersion = installedVersions[script.owner + '/' + script.repo + ':' + script.name];

            // Check if app is installed and has an update available
            if (installedVersion && installedVersion !== script.version) {
                updatesAvailable.push(script);
            }
        }
    }

    // Remove existing Updates category
    var updatesIndex = availableCategories.indexOf("Updates");
    if (updatesIndex !== -1) {
        availableCategories.splice(updatesIndex, 1);
    }
    delete releasesData["Updates"];

    // Add Updates category if there are updates available
    if (updatesAvailable.length > 0) {
        releasesData["Updates"] = updatesAvailable;
        availableCategories.unshift("Updates");
    }
}

/**
 * Select a category and load its scripts
 */
function selectCategory(categoryName) {
    lastCategoryIndex = currentScript;
    selectedCategory = categoryName;
    currentView = "scripts";
    currentScript = 0;
    resetDescriptionScroll();

    if (releasesData[categoryName]) {
        availableScripts = releasesData[categoryName];
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
    currentScript = lastCategoryIndex;
    availableScripts = [];
    selectedCategory = "";
    resetDescriptionScroll();
    displayInterface();
}

// Helper function to handle navigation (next/prev) with wrapping
function handleNavigation(isNext, maxLength, onUpdate) {
    if (maxLength === 0) return;

    currentScript = isNext
        ? (currentScript + 1) % maxLength
        : (currentScript - 1 + maxLength) % maxLength;

    if (onUpdate) onUpdate();
    displayInterface();
}

// Main application loop
while (!exitApp) {
    // Handle ESC button
    if (keyboard.getEscPress()) {
        if (showMenu) {
            hideActionMenu();
        } else if (currentView === "scripts") {
            goBackToCategories();
        } else {
            exitApp = true;
            break;
        }
    }

    if (!isDownloading) {
        if (showMenu) {
            // Handle menu navigation
            if (keyboard.getNextPress() || keyboard.getPrevPress()) {
                var isNext = keyboard.getNextPress();
                selectedMenuOption = isNext
                    ? (selectedMenuOption + 1) % menuOptions.length
                    : (selectedMenuOption - 1 + menuOptions.length) % menuOptions.length;
                displayInterface();
            }

            if (keyboard.getSelPress()) {
                executeMenuAction(availableScripts[currentScript]);
            }
        } else if (currentView === "categories") {
            // Handle category navigation
            if (keyboard.getNextPress()) {
                handleNavigation(true, availableCategories.length);
            } else if (keyboard.getPrevPress()) {
                handleNavigation(false, availableCategories.length);
            } else if (keyboard.getSelPress() && availableCategories.length > 0) {
                selectCategory(availableCategories[currentScript]);
            }
        } else {
            // Handle script navigation
            if (keyboard.getNextPress()) {
                handleNavigation(true, availableScripts.length, resetDescriptionScroll);
            } else if (keyboard.getPrevPress()) {
                handleNavigation(false, availableScripts.length, resetDescriptionScroll);
            } else if (keyboard.getSelPress() && availableScripts.length > 0) {
                showActionMenu(availableScripts[currentScript]);
            }
        }
    }

    checkStatusClear();
    updateDescriptionScroll();
    delay(50);
}
