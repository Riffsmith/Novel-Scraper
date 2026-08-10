import fs from "fs";
import path from "path";
import chalk from "chalk";

/**
 * Create a temporary working directory
 * @returns {Promise<string>} path to the created directory
 */
export async function createTempDirectory() {
    if (!fs.existsSync(this.tempDir)) {
        fs.mkdirSync(this.tempDir, { recursive: true });
    }

    // Create directory structure for EPUB
    const directories = [
        path.join(this.tempDir, "META-INF"),
        path.join(this.tempDir, "OEBPS"),
        path.join(this.tempDir, "OEBPS", "css"),
        path.join(this.tempDir, "OEBPS", "images"),
        path.join(this.tempDir, "OEBPS", "fonts"),
        path.join(this.tempDir, "OEBPS", "xhtml"),
        path.join(this.tempDir, "OEBPS", "js")
    ];

    directories.forEach((dir) => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });

}

/**
 * Copy resource files into working directory
 * @param {string} srcDir
 * @param {string} destDir
 */
export async function copyResources(srcDir, destDir) {
    // original implementation of _copyResources
    // Copy CSS
    const cssPath = path.join(this.resourcesDir, "default.css");
    if (fs.existsSync(cssPath)) {
        fs.copyFileSync(
            cssPath,
            path.join(this.tempDir, "OEBPS", "css", "styles.css")
        );
    } else {
        // Create default CSS if none exists
        const defaultCSS = `
          body {
            margin: 5%;
            font-family: serif;
            line-height: 1.5;
          }
          h1, h2, h3, h4 {
            text-align: center;
            line-height: 1.3;
          }
          .title-page {
            text-align: center;
            margin: 3em 0;
          }
          .cover-image {
            max-width: 100%;
            height: auto;
            margin: 0 auto;
            display: block;
          }
          .chapter {
            margin-top: 2em;
          }
          .chapter-title {
            margin-bottom: 1.5em;
          }
          .synopsis {
            margin: 2em 1em;
            font-style: italic;
            line-height: 1.6;
            border-left: 3px solid #888;
            padding-left: 1em;
          }
        `;
        fs.writeFileSync(
            path.join(this.tempDir, "OEBPS", "css", "styles.css"),
            defaultCSS
        );
    }

    // Copy fonts
    const fontFiles = fs
        .readdirSync(this.resourcesDir)
        .filter((file) => file.endsWith(".ttf") || file.endsWith(".otf"));

    fontFiles.forEach((fontFile) => {
        fs.copyFileSync(
            path.join(this.resourcesDir, fontFile),
            path.join(this.tempDir, "OEBPS", "fonts", fontFile)
        );
    });

    // Check if we need to add font-face rules (only if they don't exist in the CSS)
    if (fontFiles.length > 0) {
        const cssContent = fs.readFileSync(
            path.join(this.tempDir, "OEBPS", "css", "styles.css"),
            "utf8"
        );

        // Only add font-face rules if they don't already exist in the CSS
        if (!cssContent.includes("@font-face")) {
            let fontFaceCSS = "";

            fontFiles.forEach((fontFile) => {
                // Use a simpler font family name without underscores
                // This helps avoid the font name mismatch issue
                const fontFileName = path.basename(fontFile, path.extname(fontFile));
                // Extract the actual font family name (before any underscores)
                const fontFamily = fontFileName.split("_")[0];
                const fontFormat = fontFile.endsWith(".ttf")
                    ? "truetype"
                    : "opentype";

                fontFaceCSS += `
    @font-face {
      font-family: "${fontFamily}";
      src: url("../fonts/${fontFile}") format("${fontFormat}");
    }
    `;
            });

            // Don't add the duplicate body font-family rule
            // Only add if there's no existing body font-family rule
            if (!cssContent.match(/body\s*{[^}]*font-family:/)) {
                const firstFontFamily = path
                    .basename(fontFiles[0], path.extname(fontFiles[0]))
                    .split("_")[0];
                fontFaceCSS += `
    body {
      font-family: "${firstFontFamily}", serif;
    }
    `;
            }

            // Append to existing CSS
            fs.appendFileSync(
                path.join(this.tempDir, "OEBPS", "css", "styles.css"),
                fontFaceCSS
            );
        }
    }
    const jsFiles = fs.readdirSync(this.resourcesDir)
        .filter(file => file.endsWith('.js'));

    jsFiles.forEach(jsFile => {
        fs.copyFileSync(
            path.join(this.resourcesDir, jsFile),
            path.join(this.tempDir, "OEBPS", "js", jsFile)
        );
    });
}

/**
 * Remove the working directory and its contents
 * @param {string} dir
 */
export async function cleanupWorkingDirectory(dir) {
    // original implementation of _cleanupWorkingDirectory
    if (!this.deleteDir) return;

    try {
        const deleteDir = (dirPath) => {
            if (fs.existsSync(dirPath)) {
                fs.readdirSync(dirPath).forEach((file) => {
                    const curPath = path.join(dirPath, file);
                    if (fs.lstatSync(curPath).isDirectory()) {
                        deleteDir(curPath);
                    } else {
                        fs.unlinkSync(curPath);
                    }
                });
                fs.rmdirSync(dirPath);
            }
        };

        deleteDir(this.tempDir);
        if (this.deleteDir === true) {
            deleteDir(path.dirname(this.chaptersDir));
        }
    } catch (error) {
        console.error(chalk.red(`Error cleaning up: ${error.message}`));
    }
}

/**
 * Sanitize a filename for filesystem safety
 * @param {string} name
 * @returns {string}
 */
export function sanitizeFilename(name) {
    return name
        .replace(/[^a-zA-Z0-9 ._-]/g, "")  
        .replace(/\s+/g, " ")              
        .trim();                           
}

/**
 * Retrieve and sort chapter file paths
 * @param {string} chaptersDir
 * @returns {string[]} list of file paths
 */
export function getChapterFiles(chaptersDir) {
    // original implementation of _getChapterFiles
    const files = fs
        .readdirSync(this.chaptersDir)
        .filter((file) => file.endsWith(".html"));

    return files.sort((a, b) => {
        const numA = parseInt(a.split("_")[0], 10);
        const numB = parseInt(b.split("_")[0], 10);

        if (isNaN(numA) || isNaN(numB)) {
            return a.localeCompare(b);
        }

        return numA - numB;
    });
}