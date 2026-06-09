import { mkdir, readdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GPX_DIR = join(ROOT, "gpx");
const PHOTOS_DIR = join(ROOT, "photos");
const WEB_PHOTOS_DIR = join(ROOT, "photos-web");
const MANIFEST_PATH = join(ROOT, "manifest.json");

function normalizeName(value) {
  return value.replace(/^\/+/, "").replace(/\/+$/, "");
}

function baseName(value) {
  return normalizeName(value).split("/").pop() || "";
}

function fileStem(value) {
  return baseName(value).replace(/\.[^.]+$/, "");
}

function parseGpxMetadata(text) {
  const name = text.match(/<metadata>[\s\S]*?<name>([^<]+)<\/name>/i)?.[1]?.trim() || null;
  return { metadataName: name };
}

function parseGpxTimes(text) {
  const times = [...text.matchAll(/<trkpt\b[\s\S]*?<time>([^<]+)<\/time>/gi)]
    .map((match) => Date.parse(match[1]))
    .filter((value) => Number.isFinite(value));
  return {
    startMs: times[0] ?? null,
    endMs: times.at(-1) ?? null,
  };
}

function parsePhotoTimeFromFilename(fileName) {
  const match = fileName.match(/PXL_(\d{8})_(\d{9})/i);
  if (!match) return null;
  const [, datePart, timePart] = match;
  const year = Number(datePart.slice(0, 4));
  const month = Number(datePart.slice(4, 6)) - 1;
  const day = Number(datePart.slice(6, 8));
  const hour = Number(timePart.slice(0, 2));
  const minute = Number(timePart.slice(2, 4));
  const second = Number(timePart.slice(4, 6));
  const millisecond = Number(timePart.slice(6, 9));
  return Date.UTC(year, month, day, hour, minute, second, millisecond);
}

function parsePhotoTimeFromMetadata(filePath) {
  const mdls = spawnSync(
    "mdls",
    ["-raw", "-name", "kMDItemContentCreationDate", filePath],
    { encoding: "utf8" }
  );
  const output = (mdls.stdout || "").trim();
  if (output && output !== "(null)") {
    const normalized = output.replace(
      /(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([+-]\d{4})/,
      "$1T$2$3"
    );
    const parsed = Date.parse(normalized);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  const sips = spawnSync("sips", ["-g", "all", filePath], { encoding: "utf8" });
  const creation = (sips.stdout || "").match(/\bcreation:\s+(\d{4}:\d{2}:\d{2}\s+\d{2}:\d{2}:\d{2})/i)?.[1];
  if (creation) {
    const normalized = creation.replace(/:/g, "-").replace(" ", "T") + "Z";
    const parsed = Date.parse(normalized);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function formatUtc(timeMs) {
  return new Date(timeMs).toISOString();
}

function ensureSuccess(result, commandDescription) {
  if (result.status !== 0) {
    throw new Error(`${commandDescription} failed: ${result.stderr || result.stdout || "unknown error"}`);
  }
}

async function listFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function listDirs(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function convertPhoto(sourcePath, outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  const result = spawnSync(
    "magick",
    [sourcePath, "-auto-orient", "-strip", "-quality", "92", outputPath],
    { encoding: "utf8" }
  );
  if (result.status === 0) {
    return;
  }

  const sipsResult = spawnSync("sips", ["-s", "format", "jpeg", sourcePath, "--out", outputPath], {
    encoding: "utf8",
  });
  ensureSuccess(sipsResult, `Image conversion for ${sourcePath}`);
}

async function build() {
  const gpxFiles = (await listFiles(GPX_DIR)).filter((file) => /\.gpx$/i.test(file)).sort((a, b) => a.localeCompare(b));
  const photoFolders = new Set(await listDirs(PHOTOS_DIR));
  const routes = [];

  await rm(WEB_PHOTOS_DIR, { recursive: true, force: true });
  await mkdir(WEB_PHOTOS_DIR, { recursive: true });

  for (const gpxFile of gpxFiles) {
    const routeName = fileStem(gpxFile);
    const gpxPath = join(GPX_DIR, gpxFile);
    const gpxText = await readFile(gpxPath, "utf8");
    const { metadataName } = parseGpxMetadata(gpxText);
    const { startMs, endMs } = parseGpxTimes(gpxText);

    const route = {
      file: gpxFile,
      name: routeName,
      metadataName,
      startMs,
      endMs,
      photos: [],
    };

    if (photoFolders.has(routeName)) {
      const sourcePhotoDir = join(PHOTOS_DIR, routeName);
      const files = (await listFiles(sourcePhotoDir)).sort((a, b) => a.localeCompare(b));
      for (const fileName of files) {
        const ext = extname(fileName).toLowerCase();
        if (![".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"].includes(ext)) {
          continue;
        }

        const sourcePath = join(sourcePhotoDir, fileName);
        const photoTimeMs = parsePhotoTimeFromFilename(fileName) ?? parsePhotoTimeFromMetadata(sourcePath);
        if (!Number.isFinite(photoTimeMs)) {
          continue;
        }

        const outputFileName = `${fileStem(fileName)}.jpg`;
        const outputPath = join(WEB_PHOTOS_DIR, routeName, outputFileName);
        await convertPhoto(sourcePath, outputPath);

        route.photos.push({
          file: fileName,
          webUrl: `photos-web/${routeName}/${outputFileName}`,
          timeMs: photoTimeMs,
          displayTime: formatUtc(photoTimeMs),
        });
      }
    }

    routes.push(route);
  }

  await writeFile(MANIFEST_PATH, `${JSON.stringify({ routes }, null, 2)}\n`, "utf8");
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
