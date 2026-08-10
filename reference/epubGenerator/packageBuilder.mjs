import fs from "fs";
import path from "path";
import archiver from "archiver";

export async function createMimetype() {
    fs.writeFileSync(
        path.join(this.tempDir, "mimetype"),
        "application/epub+zip"
    );
}

export async function createContainerXml() {
    const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

    fs.writeFileSync(
        path.join(this.tempDir, "META-INF", "container.xml"),
        containerXml
    );
}

export async function zipEpub(outputPath) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const archive = archiver("zip", {
            zlib: { level: 9 }, // Maximum compression
        });

        output.on("close", function () {
            resolve();
        });

        archive.on("error", function (err) {
            reject(err);
        });

        archive.pipe(output);

        // Add mimetype first without compression
        archive.file(path.join(this.tempDir, "mimetype"), {
            name: "mimetype",
            store: true, // No compression for this file
        });

        // Add the rest of the files
        archive.directory(path.join(this.tempDir, "META-INF"), "META-INF");
        archive.directory(path.join(this.tempDir, "OEBPS"), "OEBPS");

        archive.finalize();
    });
}
