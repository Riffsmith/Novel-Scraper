import fs from "fs";
import path from "path";
import * as cheerio from "cheerio";
import fetch from "node-fetch";
import cliProgress from "cli-progress";
import chalk from "chalk";
import archiver from "archiver";
import { v4 as uuidv4 } from "uuid";
import * as html from "html-entities";
import {
  createTempDirectory,
  copyResources,
  cleanupWorkingDirectory,
  sanitizeFilename,
  getChapterFiles
} from './fileManager.mjs';

import { getCoverImage, getScriptTags } from './assetManager.mjs'
import { processChapter, createTitlePage, createSynopsisPage, createVolumePage } from "./contentProcessor.mjs"
import { createContentOpf } from './manifestBuilder.mjs'
import { createNavXhtml, createTocNcx, assignChaptersToVolumes, getVolumeForChapterIndex } from "./tocBuilder.mjs"
import { createMimetype, createContainerXml, zipEpub } from './packageBuilder.mjs'

export class EPUBGenerator {
  constructor(
    metadata,
    chaptersDir,
    resourcesDir,
    outputPath = null,
    deleteDir = false,
    volumes = []
  ) {
    this.metadata = metadata;
    this.chaptersDir = chaptersDir;
    this.resourcesDir = resourcesDir;
    this.outputPath = outputPath;
    this.deleteDir = deleteDir;
    this.uuid = uuidv4();
    this.tempDir = path.join(path.dirname(this.chaptersDir), "epub_temp");
    this.idCounter = 0;
    this.volumes = volumes;

    this.createTempDirectory = createTempDirectory;
    this.copyResources = copyResources;
    this.cleanupWorkingDirectory = cleanupWorkingDirectory;
    this.sanitizeFilename = sanitizeFilename;
    this.getChapterFiles = getChapterFiles;

    this.getCoverImage = getCoverImage;
    this.getScriptTags = getScriptTags;

    this.processChapter = processChapter;
    this.createTitlePage = createTitlePage;
    this.createSynopsisPage = createSynopsisPage;
    this.createVolumePage = createVolumePage;

    this.createContentOpf = createContentOpf;

    this.createNavXhtml = createNavXhtml;
    this.createTocNcx = createTocNcx;
    this.assignChaptersToVolumes = assignChaptersToVolumes;
    this.getVolumeForChapterIndex = getVolumeForChapterIndex;

    this.createMimetype = createMimetype;
    this.createContainerXml = createContainerXml;
    this.zipEpub = zipEpub;
  }


  _generateUniqueId(prefix = "id") {
    this.idCounter++;
    return `${prefix}${this.idCounter}`;
  }

  async generateEpub(customOutputPath = null) {
    // Create progress bar
    const progressBar = new cliProgress.SingleBar(
      {
        format: `${chalk.cyan(" ")}${chalk.yellow("{bar}")} ${chalk.green(
          "{percentage}%"
        )} | {stage}`,
        barCompleteChar: "█",
        barIncompleteChar: "░",
        hideCursor: true,
      },
      cliProgress.Presets.shades_classic
    );

    progressBar.start(100, 0, { stage: "Initializing" });

    try {
      // Determine output path
      let outputPath = customOutputPath || this.outputPath;
      if (!outputPath) {
        const sanitizedTitle = this.sanitizeFilename(
          this.metadata.title || "novel"
        );
        outputPath = path.join(
          path.dirname(this.chaptersDir),
          `${sanitizedTitle}.epub`
        );
      }

      const outputDir = path.dirname(outputPath);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      progressBar.update(10, { stage: "Setting up directories" });
      this.createTempDirectory();

      // Create essential EPUB files
      progressBar.update(15, { stage: "Creating EPUB structure" });
      this.createMimetype();
      this.createContainerXml();

      // Copy resources
      progressBar.update(20, { stage: "Copying resources" });
      this.copyResources();

      // Download cover if available
      progressBar.update(25, { stage: "Processing cover image" });
      const coverPath = await this.getCoverImage();

      // Create title page
      progressBar.update(30, { stage: "Creating title page" });
      await this.createTitlePage(coverPath);

      // Create synopsis page
      progressBar.update(35, { stage: "Creating synopsis page" });
      await this.createSynopsisPage();

      // Get all chapter files
      const chapterFiles = this.getChapterFiles();
      const totalChapters = chapterFiles.length;

      progressBar.update(38, { stage: "Creating volume pages" });
      const volumePages = [];
      if (this.volumes && this.volumes.length > 0) {
        // First, extract chapter indices from filenames
        const chapterIndices = chapterFiles
          .map((file) => {
            const match = file.match(/^(\d+)_/);
            return match ? parseInt(match[1], 10) - 1 : -1;
          })
          .filter((num) => num >= 0);

        // Find which volumes have chapters that are included
        const includedVolumes = new Set();

        for (const chapterIndex of chapterIndices) {
          // Find which volume this chapter belongs to
          let currentIndex = 0;
          for (let i = 0; i < this.volumes.length; i++) {
            const volumeChapterCount = this.volumes[i].chapters?.length || 0;

            if (
              chapterIndex >= currentIndex &&
              chapterIndex < currentIndex + volumeChapterCount
            ) {
              includedVolumes.add(i);
              break;
            }

            currentIndex += volumeChapterCount;
          }
        }

        // Create volume pages only for volumes that have chapters included
        for (const volumeIndex of includedVolumes) {
          const volumeInfo = await this.createVolumePage(
            this.volumes[volumeIndex],
            volumeIndex
          );
          volumePages.push(volumeInfo);
        }
      }

      // Process each chapter
      progressBar.update(40, {
        stage: "Processing chapters (0/" + totalChapters + ")",
      });
      const chapters = [];

      for (let i = 0; i < chapterFiles.length; i++) {
        // Extract the actual chapter number from the filename
        const chapterFile = chapterFiles[i];
        const match = chapterFile.match(/^(\d+)_/);
        const actualChapterIndex = match ? parseInt(match[1], 10) - 1 : i;

        // Use the actual chapter index instead of the array index
        const chapterInfo = await this.processChapter(chapterFile, actualChapterIndex);
        chapters.push(chapterInfo);

        // Update progress
        const progress = 40 + Math.floor(((i + 1) / totalChapters) * 30);
        progressBar.update(progress, {
          stage: `Processing chapters (${i + 1}/${totalChapters})`,
        });
      }

      // Create content.opf
      progressBar.update(75, { stage: "Creating content.opf" });
      this.createContentOpf(coverPath, chapters, volumePages);

      // Create navigation files
      progressBar.update(80, { stage: "Creating navigation files" });
      this.createNavXhtml(chapters, volumePages);
      this.createTocNcx(chapters, volumePages);

      // Package the EPUB
      progressBar.update(90, { stage: "Packaging EPUB" });
      await this.zipEpub(outputPath);

      // Clean up temporary files
      progressBar.update(95, { stage: "Cleaning up" });
      this.cleanupWorkingDirectory();

      progressBar.update(100, { stage: "Complete!" });
      progressBar.stop();

      console.log(
        chalk.green(
          `✓ EPUB created successfully: ${chalk.bold(
            path.basename(outputPath)
          )}`
        )
      );
      console.log(chalk.dim(`  Location: ${outputPath}`));

      return outputPath;
    } catch (error) {
      progressBar.stop();
      console.error(chalk.red(`✗ EPUB generation failed: ${error.message}`));
      throw error;
    }
  }
}
export default EPUBGenerator;