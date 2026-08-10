import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import chalk from "chalk";


export async function getCoverImage() {
    const coverUrl = this.metadata.cover_url;
    if (!coverUrl) {
        return null;
    }

    try {
        const normalizedUrl = coverUrl.startsWith("//")
            ? `https:${coverUrl}`
            : coverUrl;
        const response = await fetch(normalizedUrl);

        if (response.ok) {
            const coverBuffer = await response.buffer();
            const coverPath = path.join(
                this.tempDir,
                "OEBPS",
                "images",
                "cover.jpg"
            );
            fs.writeFileSync(coverPath, coverBuffer);
            return "images/cover.jpg";
        } else {
            console.error(
                chalk.red(`Failed to download cover image (${response.status})`)
            );
        }
    } catch (error) {
        console.error(
            chalk.red(`Could not download cover image: ${error.message}`)
        );
    }

    return null;
}

export function getScriptTags() {
        const jsDir = path.join(this.tempDir, "OEBPS", "js");
    if (!fs.existsSync(jsDir)) return '';

    const jsFiles = fs.readdirSync(jsDir).filter(file => file.endsWith('.js'));

    return jsFiles.map(jsFile =>
      `  <script type="text/javascript" src="../js/${jsFile}"></script>`
    ).join('\n');
}