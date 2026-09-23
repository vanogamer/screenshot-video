// 🌍 გლობალური UTF-8 გარემო
process.env.CHARSET = 'utf-8';
process.env.LANG = 'ka_GE.UTF-8';
process.env.LC_ALL = 'ka_GE.UTF-8';

// ===== Dependencies =====
const childProcess = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(childProcess.execFile);

// 🪟 Windows ტერმინალზე ჩართე UTF-8
try { childProcess.execSync('chcp 65001', { stdio: 'ignore' }); } catch {}

const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fileUpload = require('express-fileupload');
const archiver = require('archiver');
const path = require('path');
const os = require('os');
const fsSync = require('fs');
const fs = fsSync.promises;

// ===== Screenshot Output Settings =====
const SCREENSHOT_EXT = '.png';
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg'];
const VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv', '.mpg', '.mpeg', '.m4v', '.ts', '.m2ts', '.mts'];
const MAX_SCREENSHOTS_PER_VIDEO = Math.max(1, Number(process.env.MAX_SCREENSHOTS_PER_VIDEO || 20000));
const MAX_UPLOAD_SIZE = Math.max(1, Number(process.env.MAX_UPLOAD_SIZE_BYTES || (50 * 1024 * 1024 * 1024))); // 50GB default for large 4K local videos
const CLEANUP_MAX_AGE_MS = Math.max(60_000, Number(process.env.CLEANUP_MAX_AGE_MS || (15 * 60 * 1000)));
const OUTPUT_CLEANUP_ENABLED = false; // Generated screenshots are never deleted by the app.
// PNG output size cannot be known before frames are encoded. This value is intentionally safe,
// because FFmpeg is using low/no compression and output disk must not run out mid-job.
const PNG_ESTIMATE_BYTES_PER_PIXEL = Math.max(3.1, Number(process.env.PNG_ESTIMATE_BYTES_PER_PIXEL || 4.25));
const DISK_SPACE_SAFETY_MULTIPLIER = Math.max(1.05, Number(process.env.DISK_SPACE_SAFETY_MULTIPLIER || 1.25));
const MIN_FREE_SPACE_AFTER_JOB = Math.max(0, Number(process.env.MIN_FREE_SPACE_AFTER_JOB_BYTES || (512 * 1024 * 1024))); // keep 512MB free
const MIN_FREE_RAM_BEFORE_JOB = Math.max(0, Number(process.env.MIN_FREE_RAM_BEFORE_JOB_BYTES || (1024 * 1024 * 1024))); // keep at least 1GB RAM free; 4K jobs can need more dynamically
const MAX_BATCH_SCREENSHOTS = Math.max(MAX_SCREENSHOTS_PER_VIDEO, Number(process.env.MAX_BATCH_SCREENSHOTS || 100000));
// If a browser/MP4 file has damaged metadata but FFmpeg can still decode frames,
// continue extraction with a conservative frame cap instead of failing before the folder is created.
const UNKNOWN_DURATION_MAX_SCREENSHOTS = Math.min(
  MAX_SCREENSHOTS_PER_VIDEO,
  Math.max(100, Number(process.env.UNKNOWN_DURATION_MAX_SCREENSHOTS || 3000))
);
const UNKNOWN_METADATA_FALLBACK_WIDTH = Math.max(320, Number(process.env.UNKNOWN_METADATA_FALLBACK_WIDTH || 1920));
const UNKNOWN_METADATA_FALLBACK_HEIGHT = Math.max(240, Number(process.env.UNKNOWN_METADATA_FALLBACK_HEIGHT || 1080));
const STRICT_METADATA_READ = String(process.env.STRICT_METADATA_READ || '').toLowerCase() === 'true';
const FFPROBE_TIMEOUT_MS = Math.max(5000, Number(process.env.FFPROBE_TIMEOUT_MS || 120000)); // large 4K files can need longer metadata reads
const LOW_DISK_CHECK_INTERVAL_MS = Math.max(3000, Number(process.env.LOW_DISK_CHECK_INTERVAL_MS || 5000));
const CLEANUP_SCAN_INTERVAL_MS = Math.max(30_000, Number(process.env.CLEANUP_SCAN_INTERVAL_MS || 60_000));
const PNG_COMPRESSION_LEVEL = Math.min(9, Math.max(0, Number(process.env.PNG_COMPRESSION_LEVEL ?? 0))); // 0 = fastest, PNG remains lossless
const PNG_PIXEL_FORMAT = String(process.env.PNG_PIXEL_FORMAT || 'rgb24');
// High-accuracy chroma reconstruction for the mandatory YUV -> RGB conversion PNG requires.
// Without this, FFmpeg falls back to a fast/low-quality scaler for that color conversion,
// which visibly softens fine detail and edges even though no resolution is being changed.
const SWS_QUALITY_FLAGS = String(process.env.SWS_QUALITY_FLAGS || 'lanczos+accurate_rnd+full_chroma_int+full_chroma_inp+bitexact');
const MAX_DIMENSION = Math.max(720, Number(process.env.MAX_OUTPUT_DIMENSION || 8192)); // only used if output resize is explicitly allowed
const NATIVE_ORIGINAL_OUTPUT_LOCKED = String(process.env.ALLOW_OUTPUT_RESIZE || '').toLowerCase() !== 'true'; // default: never resize/downscale extracted frames
const MEMORY_BYTES_PER_OUTPUT_PIXEL = Math.max(24, Number(process.env.MEMORY_BYTES_PER_OUTPUT_PIXEL || 48));
const MIN_DYNAMIC_RAM_FOR_4K = Math.max(MIN_FREE_RAM_BEFORE_JOB, Number(process.env.MIN_DYNAMIC_RAM_FOR_4K_BYTES || (1536 * 1024 * 1024)));

function isImageFile(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return IMAGE_EXTS.includes(ext);
}


// ===== Utility Functions =====

function fixGeorgianLetters(str) {
  if (!str) return str;

  const variants = {
    'á\u0083\u0090': 'ა','á\u0083\u0091': 'ბ','á\u0083\u0092': 'გ','á\u0083\u0093': 'დ','á\u0083\u0094': 'ე','á\u0083\u0095': 'ვ','á\u0083\u0096': 'ზ','á\u0083\u0097': 'თ','á\u0083\u0098': 'ი','á\u0083\u0099': 'კ',
    'á\u0083\u009a': 'ლ','á\u0083\u009b': 'მ','á\u0083\u009c': 'ნ','á\u0083\u009d': 'ო','á\u0083\u009e': 'პ','á\u0083\u009f': 'ჟ','á\u0083 ': 'რ','á\u0083¡': 'ს','á\u0083¢': 'ტ','á\u0083£': 'უ',
    'á\u0083¦': 'ფ','á\u0083§': 'ქ','á\u0083¨': 'ღ','á\u0083©': 'ყ','á\u0083ª': 'შ','á\u0083«': 'ჩ','á\u0083¬': 'ც','á\u0083­': 'ძ','á\u0083®': 'წ','á\u0083¯': 'ჭ',
    'á\u0083°': 'ხ','á\u0083±': 'ჯ','á\u0083²': 'ჰ',
    'ã\u0083¡\u0083\u0090': 'ა','ã\u0083¡\u0083\u0091': 'ბ','ã\u0083¡\u0083\u0092': 'გ','ã\u0083¡\u0083\u0093': 'დ','ã\u0083¡\u0083\u0094': 'ე','ã\u0083¡\u0083\u0095': 'ვ','ã\u0083¡\u0083\u0096': 'ზ','ã\u0083¡\u0083\u0097': 'თ','ã\u0083¡\u0083\u0098': 'ი','ã\u0083¡\u0083\u0099': 'კ',
    'ã\u0083¡\u0083\u009a': 'ლ','ã\u0083¡\u0083\u009b': 'მ','ã\u0083¡\u0083\u009c': 'ნ','ã\u0083¡\u0083\u009d': 'ო','ã\u0083¡\u0083\u009e': 'პ','ã\u0083¡\u0083\u009f': 'ჟ','ã\u0083¡\u0083 ': 'რ','ã\u0083¡\u0083¡': 'ს','ã\u0083¡\u0083¢': 'ტ','ã\u0083¡\u0083£': 'უ',
    'ã\u0083¡\u0083¦': 'ფ','ã\u0083¡\u0083§': 'ქ','ã\u0083¡\u0083¨': 'ღ','ã\u0083¡\u0083©': 'ყ','ã\u0083¡\u0083ª': 'შ','ã\u0083¡\u0083«': 'ჩ','ã\u0083¡\u0083¬': 'ც','ã\u0083¡\u0083­': 'ძ','ã\u0083¡\u0083®': 'წ','ã\u0083¡\u0083¯': 'ჭ',
    'ã\u0083¡\u0083°': 'ხ','ã\u0083¡\u0083±': 'ჯ','ã\u0083¡\u0083²': 'ჰ',
    'aÌ\u0083\u0090': 'ა','aÌ\u0083\u0091': 'ბ','aÌ\u0083\u0092': 'გ','aÌ\u0083\u0093': 'დ','aÌ\u0083\u0094': 'ე','aÌ\u0083\u0095': 'ვ','aÌ\u0083\u0096': 'ზ','aÌ\u0083\u0097': 'თ','aÌ\u0083\u0098': 'ი','aÌ\u0083\u0099': 'კ',
    'aÌ\u0083\u009a': 'ლ','aÌ\u0083\u009b': 'მ','aÌ\u0083\u009c': 'ნ','aÌ\u0083\u009d': 'ო','aÌ\u0083\u009e': 'პ','aÌ\u0083\u009f': 'ჟ','aÌ\u0083 ': 'რ','aÌ\u0083¡': 'ს','aÌ\u0083¢': 'ტ','aÌ\u0083£': 'უ',
    'aÌ\u0083¦': 'ფ','aÌ\u0083§': 'ქ','aÌ\u0083¨': 'ღ','aÌ\u0083©': 'ყ','aÌ\u0083ª': 'შ','aÌ\u0083«': 'ჩ','aÌ\u0083¬': 'ც','aÌ\u0083­': 'ძ','aÌ\u0083®': 'წ','aÌ\u0083¯': 'ჭ',
    'aÌ\u0083°': 'ხ','aÌ\u0083±': 'ჯ','aÌ\u0083²': 'ჰ',
  };

  for (const [bad, good] of Object.entries(variants)) {
    str = str.replaceAll(bad, good);
  }

  return str.normalize('NFC');
}

function repairUtf8Mojibake(s) {
  s = String(s ?? '');
  const looksBroken = /Ã|Â|á\u0083|â‚¬|ð\u0178/.test(s);
  if (!looksBroken) return s.normalize('NFC');

  try {
    const fixed = Buffer.from(s, 'latin1').toString('utf8');
    return fixed.includes('\ufffd') ? s.normalize('NFC') : fixed.normalize('NFC');
  } catch {
    return s.normalize('NFC');
  }
}

function safeAsciiForDisk(name) {
  name = fixGeorgianLetters(String(name ?? '')).normalize('NFKD');
  name = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  name = name.replace(/[\u0300-\u036f]/g, '');
  name = name.replace(/[^0-9A-Za-z._-]+/g, '_');
  name = name.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  name = name.replace(/[. ]+$/g, '');

  return name || `file_${Date.now()}`;
}

function safeName(name) {
  name = fixGeorgianLetters(repairUtf8Mojibake(String(name ?? ''))).normalize('NFC');
  name = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  name = name.replace(/\s+/g, ' ').trim();
  name = name.replace(/^\.+/g, '');
  name = name.replace(/[. ]+$/g, '');

  if (!name || name === '.' || name === '..') {
    return `file_${Date.now()}`;
  }

  const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  if (WINDOWS_RESERVED.test(name)) name = '_' + name;

  const MAX_CHARS = 80;
  const chars = Array.from(name);
  if (chars.length > MAX_CHARS) name = chars.slice(0, MAX_CHARS).join('');

  return name;
}

function encSeg(s) {
  return encodeURIComponent(String(s ?? ''));
}

function safeSessionId(id) {
  const raw = String(id ?? '').trim();
  const cleaned = raw.replace(/[^0-9A-Za-z_-]/g, '').slice(0, 80);
  return cleaned || uniqueSuffix();
}

function sendJsonError(res, status, error, extra = {}) {
  if (res.headersSent || res.writableEnded || res.destroyed) return false;
  res.status(status).json({ error, ...extra });
  return true;
}

function firstBodyValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function requestValue(req, name, headerName = null) {
  const bodyValue = firstBodyValue(req?.body?.[name]);
  if (bodyValue !== undefined && bodyValue !== null && String(bodyValue).trim() !== '') return bodyValue;

  const queryValue = firstBodyValue(req?.query?.[name]);
  if (queryValue !== undefined && queryValue !== null && String(queryValue).trim() !== '') return queryValue;

  if (headerName) {
    const headerValue = req.get(headerName);
    if (headerValue !== undefined && headerValue !== null && String(headerValue).trim() !== '') return headerValue;
  }

  return undefined;
}

function parsePositiveBodyNumber(value, fallback = null) {
  const n = Number(firstBodyValue(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function buildFpsExpression(intervalSec) {
  const interval = Math.max(0.001, Number(intervalSec) || 1);
  const fps = 1 / interval;
  // For whole-second intervals, rational syntax prevents FFmpeg from treating 0.5/0.333... loosely.
  if (Number.isInteger(interval) && interval >= 1) return `1/${interval}`;
  return Number(fps.toFixed(8)).toString();
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function moveDir(src, dst) {
  try {
    await fs.rename(src, dst);
  } catch (e) {
    if (e?.code === 'EXDEV') {
      await fs.mkdir(dst, { recursive: true });
      await fs.cp(src, dst, { recursive: true });
      await fs.rm(src, { recursive: true, force: true });
      return;
    }
    if (process.platform === 'win32' && ['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) {
      await new Promise(r => setTimeout(r, 250));
      await fs.rename(src, dst);
      return;
    }
    throw e;
  }
}

async function renameNewImages(folderPath, displayBase, beforeSet = null) {
  const ext = SCREENSHOT_EXT.toLowerCase();
  const safeBase = safeName(displayBase) || `video_${Date.now()}`;
  const all = (await fs.readdir(folderPath)).filter(f => path.extname(f).toLowerCase() === ext);
  const newOnes = beforeSet ? all.filter(f => !beforeSet.has(f)) : all.slice();
  newOnes.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

  let baseOffset = 0;
  const re = new RegExp(`^${escapeRegExp(safeBase)}_(\\d{5,})${escapeRegExp(ext)}$`, 'i');

  for (const f of all) {
    const m = f.match(re);
    if (m) baseOffset = Math.max(baseOffset, parseInt(m[1], 10));
  }

  const tempNames = [];
  for (let i = 0; i < newOnes.length; i++) {
    const tmp = `.__tmp__${uniqueSuffix()}_${i}${ext}`;
    await fs.rename(path.join(folderPath, newOnes[i]), path.join(folderPath, tmp));
    tempNames.push(tmp);
  }

  for (let i = 0; i < tempNames.length; i++) {
    const n = baseOffset + (i + 1);
    const num = String(n).padStart(5, '0');
    let finalName = `${safeBase}_${num}${ext}`;
    let targetPath = path.join(folderPath, finalName);
    let bump = n;
    while (fsSync.existsSync(targetPath)) {
      bump++;
      finalName = `${safeBase}_${String(bump).padStart(5, '0')}${ext}`;
      targetPath = path.join(folderPath, finalName);
    }
    await fs.rename(path.join(folderPath, tempNames[i]), targetPath);
  }

  return newOnes.length;
}



async function directoryExists(dir) {
  try {
    const stat = await fs.stat(dir);
    return Boolean(stat?.isDirectory());
  } catch {
    return false;
  }
}

async function imageStatsInFolder(folderPath) {
  const files = await fs.readdir(folderPath).catch(() => []);
  let count = 0;
  let bytes = 0;

  for (const file of files) {
    if (!isImageFile(file)) continue;
    count += 1;
    const stat = await fs.stat(path.join(folderPath, file)).catch(() => null);
    if (stat?.isFile()) bytes += stat.size;
  }

  return { count, bytes };
}

async function countImagesInFolder(folderPath) {
  const stats = await imageStatsInFolder(folderPath);
  return stats.count;
}

async function uniqueOutputFolderName(baseName, rootDir = outputDir) {
  const cleanBase = safeName(baseName) || `folder_${Date.now()}`;
  let candidate = cleanBase;

  for (let i = 2; i < 10000; i++) {
    if (!(await directoryExists(path.join(rootDir, candidate)))) return candidate;
    candidate = `${cleanBase}_${String(i).padStart(2, '0')}`;
  }

  return `${cleanBase}_${uniqueSuffix()}`;
}

function safeZipEntryName(name, fallback = 'file') {
  const clean = safeName(name) || fallback;
  return clean.replace(/[\\/]+/g, '_');
}

async function buildScreenshotList(folderPath, folderForClient, sessionId = null) {
  const files = await fs.readdir(folderPath).catch(() => []);
  return files
    .filter(isImageFile)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    .map(f => sessionId
      ? `/screenshots/${encSeg(sessionId)}/${encSeg(folderForClient)}/${encSeg(fixGeorgianLetters(f))}`
      : `/screenshots/${encSeg(folderForClient)}/${encSeg(fixGeorgianLetters(f))}`);
}

async function cleanupUploadFiles(video, videoPath = null) {
  await Promise.all([
    videoPath ? fs.unlink(videoPath).catch(() => {}) : Promise.resolve(),
    (video?.tempFilePath && video.tempFilePath !== videoPath)
      ? fs.unlink(video.tempFilePath).catch(() => {})
      : Promise.resolve()
  ]);
}

async function finalizeScreenshotOutput({
  sessionId,
  fileKey,
  workFolderName,
  finalFolderName,
  outputFolder,
  displayBase,
  beforeImgSet,
  sameFolder,
  batchId,
  outputRoot = outputDir
}) {
  if (!outputFolder || !(await directoryExists(outputFolder))) return null;

  let folderForClient = sameFolder || batchId ? workFolderName : finalFolderName;
  let finalFolderPath = outputFolder;

  if (!sameFolder && !batchId) {
    let targetName = finalFolderName || displayBase || workFolderName;
    let targetPath = path.join(outputRoot, targetName);

    if (path.resolve(outputFolder) !== path.resolve(targetPath)) {
      if (await directoryExists(targetPath)) {
        targetName = await uniqueOutputFolderName(targetName, outputRoot);
        targetPath = path.join(outputRoot, targetName);
      }

      await moveDir(outputFolder, targetPath);
      finalFolderPath = targetPath;
      folderForClient = targetName;
    }
  }

  const newImageCount = await renameNewImages(finalFolderPath, displayBase, beforeImgSet);
  const screenshots = await buildScreenshotList(finalFolderPath, folderForClient, sessionId);

  const st = progressState.get(sessionId);
  if (st) {
    if (!Array.isArray(st.folders)) st.folders = [];
    st.folders = st.folders
      .map(f => f === workFolderName ? folderForClient : f)
      .filter((f, i, arr) => f && arr.indexOf(f) === i);
    if (!st.folders.includes(folderForClient)) st.folders.push(folderForClient);

    if (st.files?.[fileKey]) {
      st.files[fileKey].folder = folderForClient;
      st.files[fileKey].screenshots = newImageCount;
      st.files[fileKey].folderScreenshots = screenshots.length;
    }
    st.updatedAt = Date.now();
    await saveSessionManifest(sessionId, st);
  }

  return { finalFolderPath, folderForClient, screenshots, imageCount: screenshots.length, newImageCount };
}

function toAsciiFallback(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '')
    .replace(/[^0-9A-Za-z._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'download';
}

function encodeRFC5987(str) {
  return encodeURIComponent(str).replace(/['()*]/g, c =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function uniqueSuffix() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function randomDigits(n) {
  return Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
}

function parseTimemark(tm = '0:00:00.00') {
  const parts = tm.split(':');
  if (parts.length < 3) return 0;
  const [hh, mm, ss] = parts;
  return (+hh) * 3600 + (+mm) * 60 + parseFloat(ss);
}

function secondsToTimemark(sec = 0) {
  const s = Math.max(0, Number(sec) || 0);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = (s % 60).toFixed(2).padStart(5, '0');
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${ss}`;
}
function formatBytesServer(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(value >= 10 || i === 0 ? 1 : 2)} ${units[i]}`;
}

function estimatePngBytesServer(width, height) {
  const w = Math.max(1, Number(width) || 1280);
  const h = Math.max(1, Number(height) || 720);
  return Math.ceil((w * h * PNG_ESTIMATE_BYTES_PER_PIXEL) + 16384);
}


function streamRotationDegrees(stream) {
  const candidates = [];
  if (stream?.tags && stream.tags.rotate !== undefined) candidates.push(stream.tags.rotate);
  if (stream?.rotation !== undefined) candidates.push(stream.rotation);
  for (const side of Array.isArray(stream?.side_data_list) ? stream.side_data_list : []) {
    if (side?.rotation !== undefined) candidates.push(side.rotation);
    if (side?.displaymatrix && side?.rotation !== undefined) candidates.push(side.rotation);
  }

  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n)) return ((Math.round(n) % 360) + 360) % 360;
  }
  return 0;
}

function sourceVideoSize(metadata) {
  const stream = Array.isArray(metadata?.streams)
    ? metadata.streams.find(s => s?.codec_type === 'video' && Number(s?.width) > 0 && Number(s?.height) > 0)
    : null;

  const encodedWidth = Math.max(1, Number(stream?.width) || 1280);
  const encodedHeight = Math.max(1, Number(stream?.height) || 720);
  const rotation = streamRotationDegrees(stream);
  const rotated = rotation === 90 || rotation === 270;

  // FFmpeg normally auto-applies rotation metadata when extracting frames.
  // Use display dimensions for disk/RAM estimates so portrait videos are not underestimated.
  return {
    width: rotated ? encodedHeight : encodedWidth,
    height: rotated ? encodedWidth : encodedHeight,
    encodedWidth,
    encodedHeight,
    rotation,
  };
}

function normalizeResolutionValue(resolution) {
  const raw = String(resolution || 'source').trim().toLowerCase();

  // Native/original mode is intentionally locked by default.
  // Even if an old browser cache or a direct API request sends 1920x1080/4K/etc.,
  // the server ignores it and extracts the decoded frame at the video's own size.
  if (NATIVE_ORIGINAL_OUTPUT_LOCKED) return 'source';

  if (!raw || raw === 'source' || raw === 'original' || raw === 'original-quality' || raw === 'native' || raw === 'native-original') return 'source';
  if (raw === '4k' || raw === 'uhd' || raw === '2160p') return '3840x2160';
  if (raw === '2k' || raw === 'qhd' || raw === '1440p') return '2560x1440';
  if (raw === '1080p' || raw === 'fullhd' || raw === 'fhd') return '1920x1080';
  if (raw === '720p' || raw === 'hd') return '1280x720';

  const match = raw.match(/^(\d{2,5})\s*[xX:]\s*(\d{2,5})$/);
  if (!match) return 'source';

  const width = Math.min(MAX_DIMENSION, Math.max(1, Number(match[1])));
  const height = Math.min(MAX_DIMENSION, Math.max(1, Number(match[2])));
  return `${width}x${height}`;
}

function selectedResolutionSizeServer(metadata, resolution) {
  const value = normalizeResolutionValue(resolution);
  const match = value.match(/^(\d+)[xX:](\d+)$/);
  if (match) return { width: Number(match[1]), height: Number(match[2]) };
  return sourceVideoSize(metadata);
}

function estimateProcessingMemoryBytes(width, height) {
  const pixels = Math.max(1, Number(width) || 1280) * Math.max(1, Number(height) || 720);
  const dynamic = Math.ceil(pixels * MEMORY_BYTES_PER_OUTPUT_PIXEL);
  const floor = pixels >= 3840 * 2160 ? MIN_DYNAMIC_RAM_FOR_4K : MIN_FREE_RAM_BEFORE_JOB;
  return Math.max(MIN_FREE_RAM_BEFORE_JOB, floor, dynamic);
}

async function getFreeDiskInfo(targetDir) {
  const dir = targetDir || __dirname;
  await fs.mkdir(dir, { recursive: true }).catch(() => {});

  try {
    if (typeof fs.statfs === 'function') {
      const st = await fs.statfs(dir);
      const freeBytes = Number(st?.bavail || 0) * Number(st?.bsize || 0);
      if (Number.isFinite(freeBytes) && freeBytes > 0) {
        return { ok: true, freeBytes, source: 'statfs' };
      }
    }
  } catch {}

  if (process.platform === 'win32') {
    try {
      const root = path.parse(path.resolve(dir)).root || 'C:\\';
      const drive = root.replace(/[\\/:]/g, '') || 'C';
      const cmd = `(Get-PSDrive -Name '${drive.replace(/'/g, "''")}').Free`;
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], {
        timeout: 5000,
        windowsHide: true,
      });
      const freeBytes = Number(String(stdout || '').trim().split(/\s+/).pop());
      if (Number.isFinite(freeBytes) && freeBytes > 0) {
        return { ok: true, freeBytes, source: 'powershell' };
      }
    } catch {}
  }

  return { ok: false, freeBytes: null, source: 'unknown' };
}

async function checkOutputDiskSpace(estimatedOutputBytes, targetOutputDir = outputDir) {
  const estimated = Math.max(0, Number(estimatedOutputBytes) || 0);
  const requiredBytes = Math.ceil(estimated * DISK_SPACE_SAFETY_MULTIPLIER) + MIN_FREE_SPACE_AFTER_JOB;
  const disk = await getFreeDiskInfo(targetOutputDir || outputDir);
  const enough = !disk.ok || disk.freeBytes >= requiredBytes;

  return {
    canCheck: Boolean(disk.ok),
    enough,
    freeBytes: disk.freeBytes,
    freeText: disk.ok ? formatBytesServer(disk.freeBytes) : 'unknown',
    estimatedBytes: estimated,
    estimatedText: formatBytesServer(estimated),
    requiredBytes,
    requiredText: formatBytesServer(requiredBytes),
    safetyMultiplier: DISK_SPACE_SAFETY_MULTIPLIER,
    reserveBytes: MIN_FREE_SPACE_AFTER_JOB,
    source: disk.source,
  };
}


function getMemoryInfo(requiredBytes = MIN_FREE_RAM_BEFORE_JOB) {
  const freeBytes = Number(os.freemem()) || 0;
  const totalBytes = Number(os.totalmem()) || 0;
  const required = Math.max(0, Number(requiredBytes) || MIN_FREE_RAM_BEFORE_JOB);
  const enough = required <= 0 || freeBytes >= required;

  return {
    canCheck: true,
    enough,
    freeBytes,
    freeText: formatBytesServer(freeBytes),
    totalBytes,
    totalText: formatBytesServer(totalBytes),
    requiredBytes: required,
    requiredText: formatBytesServer(required),
  };
}

async function checkRuntimeCapacity({ estimatedBytes = 0, estimatedScreenshots = 0, outputRoot = outputDir, requiredMemoryBytes = MIN_FREE_RAM_BEFORE_JOB } = {}) {
  const disk = await checkOutputDiskSpace(estimatedBytes, outputRoot);
  const memory = getMemoryInfo(requiredMemoryBytes);
  const batchWithinLimit = Number(estimatedScreenshots || 0) <= MAX_BATCH_SCREENSHOTS;
  const enough = Boolean(disk.enough && memory.enough && batchWithinLimit);

  let reason = null;
  let message = null;
  if (!batchWithinLimit) {
    reason = 'too_many_screenshots';
    message = `ძალიან ბევრი სქრინშოტი გამოვა (${estimatedScreenshots}). მაქსიმუმია ${MAX_BATCH_SCREENSHOTS}. გაზარდე ინტერვალი ან შეამცირე დროის დიაპაზონი.`;
  } else if (disk.canCheck && !disk.enough) {
    reason = 'not_enough_disk';
    message = `დისკზე ადგილი არ არის საკმარისი. საჭიროა დაახლოებით ${disk.requiredText}, თავისუფალია ${disk.freeText}.`;
  } else if (!memory.enough) {
    reason = 'not_enough_memory';
    message = `RAM მეხსიერება არ არის საკმარისი მძიმე დამუშავებისთვის. საჭიროა თავისუფალი მინიმუმ ${memory.requiredText}, ახლა თავისუფალია ${memory.freeText}.`;
  }

  return { enough, reason, message, disk, memory, batchWithinLimit };
}

function createHttpError(statusCode, message, extra = {}) {
  const err = new Error(message || 'Request failed');
  err.statusCode = statusCode;
  err.publicMessage = message || 'Request failed';
  err.extra = extra;
  return err;
}

function capacityError(statusCode, capacity) {
  return createHttpError(statusCode, capacity.message || 'სისტემის რესურსები არ არის საკმარისი.', {
    reason: capacity.reason,
    disk: capacity.disk,
    memory: capacity.memory,
    batchWithinLimit: capacity.batchWithinLimit,
  });
}


function fileRunKey(sessionId, fileKey) {
  return `${safeSessionId(sessionId)}:${String(fileKey || '')}`;
}

function rememberForcedFileStop(sessionId, fileKey, reason, message, extra = {}) {
  if (!sessionId || !fileKey) return;
  forcedFileStops.set(fileRunKey(sessionId, fileKey), { reason, message, extra, at: Date.now() });
}

function peekForcedFileStop(sessionId, fileKey) {
  if (!sessionId || !fileKey) return null;
  return forcedFileStops.get(fileRunKey(sessionId, fileKey)) || null;
}

function takeForcedFileStop(sessionId, fileKey) {
  if (!sessionId || !fileKey) return null;
  const key = fileRunKey(sessionId, fileKey);
  const info = forcedFileStops.get(key) || null;
  if (info) forcedFileStops.delete(key);
  return info;
}

async function checkDiskDuringProcessing(sessionId, fileKey, estimatedRemainingBytes = 0, outputRoot = null) {
  const disk = await checkOutputDiskSpace(estimatedRemainingBytes, outputRoot || getSessionOutputRoot(sessionId));
  if (disk.canCheck && !disk.enough) {
    return {
      ok: false,
      reason: 'low_disk_during_process',
      message: `დისკზე ადგილი აღარ არის უსაფრთხო დამუშავებისთვის. საჭიროა დაახლოებით ${disk.requiredText}, თავისუფალია ${disk.freeText}.`,
      disk,
    };
  }
  return { ok: true, disk };
}

async function waitWhilePaused(sessionId) {
  while (pausedSessions.has(sessionId) && !canceledSessions.has(sessionId)) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

function statusFromForcedStop(forced, wasCanceled) {
  if (wasCanceled) return 'canceled';
  if (forced?.reason === 'stopped_current') return 'stopped';
  return 'error';
}

function isExpectedUserStop(err, forced, sessionId) {
  const reason = String(forced?.reason || err?.reason || err?.extra?.reason || '');
  if (reason === 'stopped_current' || reason === 'canceled_session' || reason === 'canceled_while_queued') return true;
  if (sessionId && canceledSessions.has(sessionId)) return true;
  const msg = String(forced?.message || err?.message || err || '').toLowerCase();
  return msg === 'canceled' || msg.includes('canceled') || msg.includes('cancelled') || msg.includes('გაუქმდა') || msg.includes('შეჩერდა');
}

function logFfmpegStopOrError(label, err, forced, sessionId) {
  const message = forced?.message || err?.message || err || 'დამუშავება შეჩერდა.';
  if (isExpectedUserStop(err, forced, sessionId)) {
    console.log(`⏹️ ${label}: ${message}`);
    return;
  }
  console.error(`❌ ${label}:`, err);
}

function broadcastTerminalState(sessionId, fileKey, stFile) {
  if (!sessionId || !fileKey || !stFile) return;
  const type = stFile.status === 'stopped' ? 'stopped' : (stFile.status === 'canceled' ? 'canceled' : 'error');
  broadcast(sessionId, { type, fileKey, ...stFile });
}

function makeSparseOutputOptions(scaleFilter) {
  const options = [];
  if (scaleFilter) options.push('-vf', scaleFilter);
  options.push(
    '-sws_flags', SWS_QUALITY_FLAGS,
    '-frames:v', '1', '-an', '-vcodec', 'png', '-pix_fmt', PNG_PIXEL_FORMAT, '-compression_level', String(PNG_COMPRESSION_LEVEL)
  );
  return options;
}

function ffprobeFile(videoPath) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(createHttpError(408, 'ვიდეოს ინფორმაციის წაკითხვა ძალიან დიდხანს გაგრძელდა. სცადე სხვა ფორმატი ან პატარა ვიდეო.', { reason: 'ffprobe_timeout' }));
    }, FFPROBE_TIMEOUT_MS);

    ffmpeg.ffprobe(videoPath, (err, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(createHttpError(400, 'ვიდეოს metadata ვერ წავიკითხე. ფაილი შეიძლება დაზიანებული იყოს ან ფორმატი არ იყოს მხარდაჭერილი.', { reason: 'ffprobe_error', detail: String(err?.message || err) }));
      else resolve(data);
    });
  });
}

function unknownMetadataFallback(error) {
  return {
    metadata: {
      format: { duration: null },
      streams: [{ codec_type: 'video', width: UNKNOWN_METADATA_FALLBACK_WIDTH, height: UNKNOWN_METADATA_FALLBACK_HEIGHT }],
    },
    warning: {
      reason: 'metadata_unreadable_fallback',
      message: 'ვიდეოს metadata ვერ წავიკითხე, მაგრამ FFmpeg-ით დამუშავება მაინც გაგრძელდა შეზღუდული უსაფრთხო cap-ით.',
      detail: String(error?.extra?.detail || error?.message || error || ''),
    },
  };
}


function buildCaptureTimes(startSec = 0, segmentDuration = 0, intervalSec = 1) {
  const safeStart = Math.max(0, Number(startSec) || 0);
  const safeDuration = Math.max(0, Number(segmentDuration) || 0);
  const safeInterval = Math.max(0.001, Number(intervalSec) || 1);
  const end = safeStart + safeDuration;
  const epsilon = Math.min(1e-6, safeInterval / 1000);
  const times = [];

  for (let i = 0; ; i++) {
    const t = safeStart + (i * safeInterval);
    if (t > end + epsilon) break;
    times.push(Number(t.toFixed(6)));
  }

  if (!times.length) {
    times.push(Number(safeStart.toFixed(6)));
  }

  return times;
}

function buildScalePadFilter(resolution) {
  if (NATIVE_ORIGINAL_OUTPUT_LOCKED) return null;

  const value = normalizeResolutionValue(resolution);
  if (!value || value === 'source') return null;

  const m = value.match(/^(\d+)[xX:](\d+)$/);
  if (!m) return null;

  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;

  return `scale=${w}:${h}:flags=lanczos:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`;
}

// ===== App Setup =====
const app = express();
app.disable('x-powered-by');

function configureFfmpegBinary() {
  const ffmpegPath = process.env.FFMPEG_PATH || (process.platform === 'win32' && fsSync.existsSync('C:\\ffmpeg\\bin\\ffmpeg.exe') ? 'C:\\ffmpeg\\bin\\ffmpeg.exe' : null);
  const ffprobePath = process.env.FFPROBE_PATH || (process.platform === 'win32' && fsSync.existsSync('C:\\ffmpeg\\bin\\ffprobe.exe') ? 'C:\\ffmpeg\\bin\\ffprobe.exe' : null);
  if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
  if (ffprobePath) ffmpeg.setFfprobePath(ffprobePath);
}
configureFfmpegBinary();

const uploadsDir = path.join(__dirname, 'uploads');
const outputDir = path.resolve(process.env.OUTPUT_DIR || path.join(__dirname, 'screenshots'));
const tempDir = path.join(__dirname, 'temp');
const publicDir = path.join(__dirname, 'public');
const ENABLE_CUSTOM_OUTPUT = false; // Site-only build: custom save-location picker and Electron/EXE mode are removed.


function normalizeOutputPath(raw) {
  if (!ENABLE_CUSTOM_OUTPUT) return outputDir;
  const value = String(raw ?? '').trim();
  if (!value || value === 'default' || value === '__default__') return outputDir;
  // Site-only build uses the project screenshots folder. Relative paths resolve inside the project.
  const cleaned = value.replace(/[\u0000-\u001F]/g, '').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return outputDir;
  return path.resolve(cleaned);
}

function getCommonOutputLocations() {
  const home = os.homedir() || __dirname;
  return {
    default: outputDir,
    desktop: path.join(home, 'Desktop', 'Video Screenshots'),
    downloads: path.join(home, 'Downloads', 'Video Screenshots'),
    documents: path.join(home, 'Documents', 'Video Screenshots'),
    pictures: path.join(home, 'Pictures', 'Video Screenshots'),
  };
}

async function resolveOutputRoot(raw, { create = true } = {}) {
  const resolved = normalizeOutputPath(raw);
  if (create) {
    await fs.mkdir(resolved, { recursive: true });
    const testFile = path.join(resolved, `.write_test_${uniqueSuffix()}.tmp`);
    await fs.writeFile(testFile, 'ok');
    await fs.rm(testFile, { force: true }).catch(() => {});
  }
  return {
    path: resolved,
    displayPath: resolved,
    isDefault: path.resolve(resolved) === path.resolve(outputDir),
  };
}

function getSessionOutputRoot(sessionOrState) {
  const st = typeof sessionOrState === 'string' ? progressState.get(safeSessionId(sessionOrState)) : sessionOrState;
  return path.resolve(st?.outputRoot || outputDir);
}

function safeJoinUnder(root, ...parts) {
  const base = path.resolve(root || outputDir);
  const full = path.resolve(base, ...parts.map(p => String(p || '')));
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw createHttpError(400, 'არასწორი ფაილის გზა.', { reason: 'invalid_path' });
  }
  return full;
}

async function saveSessionManifest(sessionId, st) {
  // Keep session state in memory only. The app must not create a hidden session folder.
  return;
}

async function loadSessionManifest(sessionId, root = outputDir) {
  return null;
}

async function ensureRuntimeFolders() {
  await Promise.all([
    fs.mkdir(uploadsDir, { recursive: true }),
    fs.mkdir(outputDir, { recursive: true }),
    fs.mkdir(tempDir, { recursive: true }),
    fs.mkdir(publicDir, { recursive: true }),
    fs.mkdir(path.join(__dirname, 'output'), { recursive: true })
  ]);
}

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(fileUpload({
  createParentPath: true,
  useTempFiles: true,
  tempFileDir: tempDir,
  limits: { fileSize: MAX_UPLOAD_SIZE },
  abortOnLimit: true,
  safeFileNames: false,
  preserveExtension: true,
}));

app.use((req, res, next) => {
  if (req.path === '/' || /\.(html|css|js)$/i.test(req.path)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
  next();
});
app.use(express.static(publicDir, { extensions: ['html'], maxAge: 0, etag: false, lastModified: false }));
app.get('/screenshots/:sessionId/:folderName/:fileName', async (req, res) => {
  try {
    const sessionId = safeSessionId(req.params.sessionId);
    const st = progressState.get(sessionId);
    const root = getSessionOutputRoot(st);
    const filePath = safeJoinUnder(root, req.params.folderName, req.params.fileName);
    res.sendFile(filePath);
  } catch (e) {
    res.status(Number(e?.statusCode) || 404).send('File not found');
  }
});
app.use('/screenshots', (req, res, next) => express.static(outputDir)(req, res, next));
app.use('/output', express.static(path.join(__dirname, 'output')));

// ===== Job Queue =====
const MAX_ACTIVE_JOBS = Number(process.env.MAX_ACTIVE_JOBS || 1);
let activeJobs = 0;
const jobQueue = [];

function acquireJobSlot() {
  return new Promise(resolve => {
    if (activeJobs < MAX_ACTIVE_JOBS) {
      activeJobs++;
      resolve();
      return;
    }
    jobQueue.push(resolve);
  });
}

function releaseJobSlot() {
  activeJobs = Math.max(0, activeJobs - 1);
  const next = jobQueue.shift();
  if (next) {
    activeJobs++;
    next();
  }
}

// ===== State Management =====
const sseClients = new Map();
const progressState = new Map();
const runningFfmpeg = new Map();
const runningFfmpegMeta = new Map();
const canceledSessions = new Set();
const pausedSessions = new Set();
const forcedFileStops = new Map();
const stopCurrentRequests = new Set();

function trackFfmpeg(sessionId, cmd, fileKey = null) {
  if (!runningFfmpeg.has(sessionId)) runningFfmpeg.set(sessionId, new Set());
  runningFfmpeg.get(sessionId).add(cmd);
  runningFfmpegMeta.set(cmd, { sessionId, fileKey, startedAt: Date.now() });
}

function untrackFfmpeg(sessionId, cmd) {
  const set = runningFfmpeg.get(sessionId);
  if (set) {
    set.delete(cmd);
    if (set.size === 0) runningFfmpeg.delete(sessionId);
  }
  runningFfmpegMeta.delete(cmd);
}

function killSessionFfmpeg(sessionId) {
  const set = runningFfmpeg.get(sessionId);
  if (!set) return 0;

  let killed = 0;
  for (const cmd of Array.from(set)) {
    try {
      const meta = runningFfmpegMeta.get(cmd);
      if (meta?.fileKey) rememberForcedFileStop(sessionId, meta.fileKey, 'canceled_session', 'დამუშავება გაუქმდა.');
      cmd.kill('SIGKILL');
      killed++;
    } catch {}
  }
  runningFfmpeg.delete(sessionId);
  return killed;
}

function stopCurrentFfmpeg(sessionId) {
  stopCurrentRequests.add(sessionId);
  const set = runningFfmpeg.get(sessionId);
  if (!set || set.size === 0) return { killed: 0, fileKey: null };

  const cmd = Array.from(set)[0];
  const meta = runningFfmpegMeta.get(cmd) || {};
  if (meta.fileKey) {
    rememberForcedFileStop(sessionId, meta.fileKey, 'stopped_current', 'მიმდინარე ვიდეო შეჩერდა. Batch გაგრძელდება შემდეგ ვიდეოზე.');
    stopCurrentRequests.delete(sessionId);
  }

  try {
    cmd.kill('SIGKILL');
    return { killed: 1, fileKey: meta.fileKey || null };
  } catch {
    return { killed: 0, fileKey: meta.fileKey || null };
  }
}

function broadcast(sessionId, payload) {
  const clients = sseClients.get(sessionId);
  if (!clients) return;

  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(data);
    } catch {}
  }
}

async function getExistingSessionFolders(sessionId) {
  let st = progressState.get(sessionId);
  let folders = Array.isArray(st?.folders) ? st.folders : [];
  let root = getSessionOutputRoot(st);

  if (!folders.length) {
    const manifest = await loadSessionManifest(sessionId, root);
    if (manifest?.folders?.length) {
      st = {
        files: {},
        folders: manifest.folders,
        zipBase: manifest.zipBase || null,
        outputRoot: manifest.outputRoot || root,
        outputDisplayPath: manifest.outputDisplayPath || manifest.outputRoot || root,
        outputIsCustom: Boolean(manifest.outputIsCustom),
        updatedAt: manifest.updatedAt || Date.now(),
      };
      progressState.set(sessionId, st);
      folders = st.folders;
      root = getSessionOutputRoot(st);
    }
  }

  if (!folders.length) return { st, existing: [], outputRoot: root };

  const existing = [];
  for (const folderName of folders) {
    try {
      const stat = await fs.stat(safeJoinUnder(root, folderName));
      if (stat?.isDirectory()) existing.push(folderName);
    } catch {}
  }

  return { st, existing, outputRoot: root };
}

// ===== Routes =====

app.get('/api/output-locations', async (_, res) => {
  if (!ENABLE_CUSTOM_OUTPUT) {
    const currentDisk = await getFreeDiskInfo(outputDir);
    return res.json({
      ok: true,
      customOutputEnabled: false,
      defaultOutputPath: outputDir,
      locations: { default: outputDir },
      disk: {
        canCheck: Boolean(currentDisk.ok),
        freeBytes: currentDisk.freeBytes,
        freeText: currentDisk.ok ? formatBytesServer(currentDisk.freeBytes) : 'unknown',
        source: currentDisk.source,
      },
    });
  }
  const locations = getCommonOutputLocations();
  const currentDisk = await getFreeDiskInfo(outputDir);
  res.json({
    ok: true,
    defaultOutputPath: outputDir,
    locations,
    disk: {
      canCheck: Boolean(currentDisk.ok),
      freeBytes: currentDisk.freeBytes,
      freeText: currentDisk.ok ? formatBytesServer(currentDisk.freeBytes) : 'unknown',
      source: currentDisk.source,
    },
  });
});


// Custom output folder picker route removed in the site-only build.

app.post('/api/output-location/check', async (req, res) => {
  if (!ENABLE_CUSTOM_OUTPUT) {
    const disk = await getFreeDiskInfo(outputDir);
    return res.json({ ok: true, customOutputEnabled: false, outputPath: outputDir, displayPath: outputDir, isDefault: true, disk: { canCheck: Boolean(disk.ok), freeBytes: disk.freeBytes, freeText: disk.ok ? formatBytesServer(disk.freeBytes) : 'unknown', source: disk.source } });
  }
  try {
    const info = await resolveOutputRoot(req.body?.outputPath, { create: true });
    const disk = await getFreeDiskInfo(info.path);
    res.json({
      ok: true,
      outputPath: info.path,
      displayPath: info.displayPath,
      isDefault: info.isDefault,
      disk: {
        canCheck: Boolean(disk.ok),
        freeBytes: disk.freeBytes,
        freeText: disk.ok ? formatBytesServer(disk.freeBytes) : 'unknown',
        source: disk.source,
      },
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: 'output_path_error', message: e?.message || 'შენახვის საქაღალდე მიუწვდომელია.' });
  }
});

app.get('/api/health', async (_, res) => {
  const memory = getMemoryInfo();
  const disk = await getFreeDiskInfo(outputDir);
  res.json({
    ok: true,
    activeJobs,
    queuedJobs: jobQueue.length,
    uptime: Math.round(process.uptime()),
    maxScreenshotsPerVideo: MAX_SCREENSHOTS_PER_VIDEO,
    maxBatchScreenshots: MAX_BATCH_SCREENSHOTS,
    cleanupMaxAgeMs: 0,
    cleanupMaxAgeText: 'never',
    outputCleanupEnabled: OUTPUT_CLEANUP_ENABLED,
    cleanupScanIntervalMs: CLEANUP_SCAN_INTERVAL_MS,
    outputPath: outputDir,
    customOutputEnabled: ENABLE_CUSTOM_OUTPUT,
    pausedSessions: pausedSessions.size,
    memory,
    disk: {
      canCheck: Boolean(disk.ok),
      freeBytes: disk.freeBytes,
      freeText: disk.ok ? formatBytesServer(disk.freeBytes) : 'unknown',
      source: disk.source,
    },
  });
});

app.post('/api/preflight', async (req, res) => {
  try {
    const estimatedBytes = Math.max(0, Number(req.body?.estimatedBytes) || 0);
    const estimatedScreenshots = Math.max(0, Number(req.body?.estimatedScreenshots) || 0);
    const fileCount = Math.max(0, Number(req.body?.fileCount) || 0);
    const requiredMemoryBytes = Math.max(MIN_FREE_RAM_BEFORE_JOB, Number(req.body?.requiredMemoryBytes) || MIN_FREE_RAM_BEFORE_JOB);
    const outputInfo = await resolveOutputRoot(req.body?.outputPath, { create: true });
    const capacity = await checkRuntimeCapacity({ estimatedBytes, estimatedScreenshots, outputRoot: outputInfo.path, requiredMemoryBytes });
    const disk = capacity.disk;
    const memory = capacity.memory;

    res.status(capacity.enough ? 200 : 507).json({
      ok: true,
      enough: capacity.enough,
      reason: capacity.reason,
      message: capacity.message,
      canCheck: disk.canCheck,
      diskEnough: disk.enough,
      memoryEnough: memory.enough,
      batchWithinLimit: capacity.batchWithinLimit,
      estimatedBytes: disk.estimatedBytes,
      estimatedSize: disk.estimatedText,
      requiredBytes: disk.requiredBytes,
      requiredSize: disk.requiredText,
      freeBytes: disk.freeBytes,
      freeSize: disk.freeText,
      memoryFreeBytes: memory.freeBytes,
      memoryFreeSize: memory.freeText,
      memoryRequiredBytes: memory.requiredBytes,
      memoryRequiredSize: memory.requiredText,
      estimatedScreenshots,
      fileCount,
      maxScreenshotsPerVideo: MAX_SCREENSHOTS_PER_VIDEO,
      maxBatchScreenshots: MAX_BATCH_SCREENSHOTS,
      safetyMultiplier: disk.safetyMultiplier,
      reserveBytes: disk.reserveBytes,
      source: disk.source,
      outputPath: outputInfo.path,
      outputDisplayPath: outputInfo.displayPath,
      outputIsDefault: outputInfo.isDefault,
      outputIsCustom: false,
      outputPreserved: true,
      outputCleanupEnabled: OUTPUT_CLEANUP_ENABLED,
      cleanupMaxAgeMs: 0,
      cleanupMaxAgeText: 'never',
    });
  } catch (e) {
    console.error('Preflight API error:', e);
    res.status(400).json({ ok: false, enough: false, error: 'preflight_error', message: e?.message || 'წინასწარი შემოწმება ვერ შესრულდა.' });
  }
});

app.get('/', (_, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/results.html', (_, res) => res.sendFile(path.join(publicDir, 'results.html')));
app.get('/tailwindcss', (_, res) => res.redirect(301, '/tailwind.css'));

app.get('/progress/:sessionId', (req, res) => {
  const sessionId = safeSessionId(req.params.sessionId);

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch {}
  }, 25_000);

  if (!sseClients.has(sessionId)) sseClients.set(sessionId, new Set());
  sseClients.get(sessionId).add(res);

  const snapshot = progressState.get(sessionId) || { files: {}, folders: [], zipBase: null };
  res.write(`data: ${JSON.stringify({ type: 'snapshot', ...snapshot })}\n\n`);

  req.on('close', () => {
    clearInterval(heartbeat);
    const set = sseClients.get(sessionId);
    if (set) {
      set.delete(res);
      if (set.size === 0) sseClients.delete(sessionId);
    }
  });
});

app.post('/api/session/:sessionId/cancel', (req, res) => {
  const sessionId = safeSessionId(req.params.sessionId);

  canceledSessions.add(sessionId);
  setTimeout(() => canceledSessions.delete(sessionId), 10 * 60 * 1000);

  const killed = killSessionFfmpeg(sessionId);

  const st = progressState.get(sessionId);
  if (st?.files) {
    for (const fk of Object.keys(st.files)) {
      if (st.files[fk]?.status === 'processing') st.files[fk].status = 'canceled';
    }
    st.updatedAt = Date.now();
  }

  broadcast(sessionId, { type: 'snapshot', ...(progressState.get(sessionId) || { files: {}, folders: [], zipBase: null }) });

  res.json({ ok: true, killed });
});


app.post('/api/session/:sessionId/pause', (req, res) => {
  const sessionId = safeSessionId(req.params.sessionId);
  pausedSessions.add(sessionId);
  const st = progressState.get(sessionId);
  if (st) {
    st.paused = true;
    st.updatedAt = Date.now();
  }
  broadcast(sessionId, { type: 'paused', paused: true });
  res.json({ ok: true, paused: true });
});

app.post('/api/session/:sessionId/resume', (req, res) => {
  const sessionId = safeSessionId(req.params.sessionId);
  pausedSessions.delete(sessionId);
  const st = progressState.get(sessionId);
  if (st) {
    st.paused = false;
    st.updatedAt = Date.now();
  }
  broadcast(sessionId, { type: 'resumed', paused: false });
  res.json({ ok: true, paused: false });
});

app.post('/api/session/:sessionId/stop-current', (req, res) => {
  const sessionId = safeSessionId(req.params.sessionId);
  const stopped = stopCurrentFfmpeg(sessionId);
  if (stopped.fileKey) {
    const st = progressState.get(sessionId);
    if (st?.files?.[stopped.fileKey]) {
      st.files[stopped.fileKey].status = 'stopped';
      st.files[stopped.fileKey].error = 'მიმდინარე ვიდეო შეჩერდა.';
      st.updatedAt = Date.now();
      broadcast(sessionId, { type: 'stopped', fileKey: stopped.fileKey, ...st.files[stopped.fileKey] });
    }
  }
  res.json({ ok: true, ...stopped });
});

app.delete('/api/session/:sessionId', async (req, res) => {
  try {
    const sessionId = safeSessionId(req.params.sessionId);
    canceledSessions.add(sessionId);
    setTimeout(() => canceledSessions.delete(sessionId), 5 * 60 * 1000);
    const killed = killSessionFfmpeg(sessionId);
    const st = progressState.get(sessionId);
    const folders = Array.isArray(st?.folders) ? st.folders : [];
    progressState.delete(sessionId);
    broadcast(sessionId, { type: 'cleared', files: {}, folders: [], zipBase: null });
    res.json({ ok: true, killed, removedFolders: 0, preservedFolders: folders.length });
  } catch (e) {
    console.error('Clear-session API error:', e);
    res.status(500).json({ ok: false, error: 'clear_error' });
  }
});

app.get('/api/session/:sessionId/screenshots', async (req, res) => {
  try {
    const sessionId = safeSessionId(req.params.sessionId);
    const { st, existing, outputRoot } = await getExistingSessionFolders(sessionId);

    if (!Array.isArray(st?.folders) || !st.folders.length) {
      return res.status(404).json({ message: 'სქრინშოტები არ მოიძებნა.', screenshots: [] });
    }

    if (!existing.length) {
      return res.status(404).json({ message: 'სქრინშოტები არ მოიძებნა.', screenshots: [] });
    }

    const screenshots = [];
    let imageBytes = 0;
    for (const folderName of existing) {
      const folderPath = safeJoinUnder(outputRoot, folderName);
      const files = await fs.readdir(folderPath).catch(() => []);

      for (const f of files.filter(isImageFile).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))) {
        screenshots.push(`/screenshots/${encSeg(sessionId)}/${encSeg(folderName)}/${encSeg(f)}`);
        const stat = await fs.stat(path.join(folderPath, f)).catch(() => null);
        if (stat?.isFile()) imageBytes += stat.size;
      }
    }

    const sizeInfo = imageBytes ? ` / ${formatBytesServer(imageBytes)}` : '';
    const message = st?.zipBase && !String(st.zipBase).startsWith('batch_')
      ? `${st.zipBase} → ნაპოვნია ${screenshots.length} სქრინშოტი${sizeInfo}.`
      : `ნაპოვნია ${screenshots.length} სქრინშოტი${sizeInfo}.`;

    res.json({ sessionId, folders: existing, zipBase: st?.zipBase || null, message, screenshots, imageBytes });
  } catch (e) {
    console.error('Screenshots API error:', e);
    res.status(500).json({ message: 'API შეცდომა.', screenshots: [] });
  }
});

app.get('/api/session/:sessionId/download-status', async (req, res) => {
  try {
    const sessionId = safeSessionId(req.params.sessionId);
    const { st, existing, outputRoot } = await getExistingSessionFolders(sessionId);

    let imageCount = 0;
    let imageBytes = 0;
    for (const folderName of existing) {
      const stats = await imageStatsInFolder(safeJoinUnder(outputRoot, folderName));
      imageCount += stats.count;
      imageBytes += stats.bytes;
    }

    res.json({
      ok: true,
      sessionId,
      ready: existing.length > 0 && imageCount > 0,
      folders: existing,
      folderCount: existing.length,
      imageCount,
      imageBytes,
      imageSize: formatBytesServer(imageBytes),
      zipBase: st?.zipBase || null,
    });
  } catch (e) {
    console.error('Download-status API error:', e);
    res.status(500).json({ ok: false, ready: false, error: 'status_error' });
  }
});

app.get('/download/:sessionId.zip', async (req, res) => {
  let archive = null;
  let finished = false;
  let aborted = false;

  try {
    const sessionId = safeSessionId(req.params.sessionId);
    const { st, existing, outputRoot } = await getExistingSessionFolders(sessionId);

    if (!Array.isArray(st?.folders) || !st.folders.length) {
      return res.status(404).send('No screenshots found for this session.');
    }

    if (!existing.length) {
      return res.status(404).send('No screenshots found for this session.');
    }

    const zipBase = safeName(st?.zipBase || `batch_${sessionId}`) || `batch_${sessionId}`;
    const zipName = `${zipBase}.zip`;
    const fallback = `${toAsciiFallback(zipBase)}.zip`;

    res.status(200);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRFC5987(zipName)}`);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    archive = archiver('zip', { zlib: { level: 9 } });

    const abortArchive = () => {
      if (aborted) return;
      aborted = true;
      try { archive?.abort(); } catch {}
    };

    req.on('aborted', abortArchive);
    req.on('close', () => {
      if (!finished) abortArchive();
    });

    archive.on('warning', (warn) => {
      console.warn('ZIP warning:', warn);
    });

    archive.on('error', err => {
      console.error('❌ ZIP error:', err);
      if (!res.headersSent) {
        try { res.status(500).send('ZIP build error'); } catch {}
      } else {
        try { res.end(); } catch {}
      }
    });

    archive.pipe(res);

    // ZIP-ში აღარ ვქმნით შემთხვევით img_XXXXX / v1 სახელებს.
    // ფოლდერის და სურათების სახელები რჩება ისე, როგორც გენერაციისას დაერქვა.
    const zipRoot = safeZipEntryName(zipBase, `screenshots_${sessionId}`);

    for (let i = 0; i < existing.length; i++) {
      const folderName = existing[i];
      const absFolder = safeJoinUnder(outputRoot, folderName);
      const files = await fs.readdir(absFolder).catch(() => []);
      const imgs = files.filter(isImageFile).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

      const sub = existing.length > 1 ? safeZipEntryName(folderName, `video_${i + 1}`) : '';

      for (const img of imgs) {
        const src = path.join(absFolder, img);
        const entryName = safeZipEntryName(img, path.basename(img) || 'screenshot.png');
        const dest = sub ? `${zipRoot}/${sub}/${entryName}` : `${zipRoot}/${entryName}`;
        archive.file(src, { name: dest });
      }
    }

    res.on('finish', () => {
      finished = true;
    });

    await archive.finalize();

  } catch (e) {
    console.error('Download endpoint error:', e);
    if (!res.headersSent) {
      res.status(500).send('Download error');
    } else {
      try { res.end(); } catch {}
    }
  }
});

// ===== Upload Endpoint (მთავარი ცვლილება) =====
app.post('/upload', async (req, res) => {
  let slotAcquired = false;
  let command = null;
  let sessionId = null;
  let videoPath = null;
  let video = null;
  let originalName = null;
  let displayOriginalName = null;
  let displayBase = null;
  let diskBase = null;
  let sameFolder = false;
  let batchId = null;
  let workFolderName = null;
  let finalFolderName = null;
  let outputFolder = null;
  let beforeImgSet = null;
  let fileKey = null;
  let finalizedOutput = null;
  let outputRoot = outputDir;
  let outputInfo = null;
  let state = null;

  try {
    video = req.files?.video;
    if (Array.isArray(video)) video = video[0];
    if (!video) return sendJsonError(res, 400, 'ვიდეო არ აირჩიე.');

    originalName = fixGeorgianLetters(repairUtf8Mojibake(video.name));
    const rawRelativePath = requestValue(req, 'relativePath', 'x-upload-relative-path');
    displayOriginalName = rawRelativePath
      ? fixGeorgianLetters(repairUtf8Mojibake(String(rawRelativePath).replace(/[\\]+/g, '/')))
      : originalName;
    const ext = path.extname(originalName).toLowerCase();

    if (!VIDEO_EXTS.includes(ext)) {
      await cleanupUploadFiles(video, videoPath);
      return sendJsonError(res, 400, 'არასწორი ვიდეო ფორმატი.');
    }

    const interval = parsePositiveBodyNumber(requestValue(req, 'interval', 'x-upload-interval'), null);
    if (interval === null) {
      await cleanupUploadFiles(video, videoPath);
      return sendJsonError(res, 400, 'ინტერვალი არასწორია ან სერვერზე არ მივიდა. თავიდან აირჩიე ინტერვალი და სცადე.');
    }
    const resolution = normalizeResolutionValue(requestValue(req, 'resolution', 'x-upload-resolution') || 'source');
    const rawStartTime = Number(requestValue(req, 'startTime', 'x-upload-start-time')); 
    const startTime = Number.isFinite(rawStartTime) && rawStartTime >= 0 ? rawStartTime : 0;
    const rawEndTime = Number(requestValue(req, 'endTime', 'x-upload-end-time')); 
    const endTime = Number.isFinite(rawEndTime) && rawEndTime >= 0 ? rawEndTime : null;
    if (endTime !== null && endTime <= startTime) {
      await cleanupUploadFiles(video, videoPath);
      return sendJsonError(res, 400, 'დასრულების დრო უნდა იყოს დაწყების დროზე მეტი.');
    }
    sameFolder = String(requestValue(req, 'sameFolder', 'x-upload-same-folder')) === 'true'; // boolean
    sessionId = safeSessionId(requestValue(req, 'sessionId', 'x-upload-session-id') || uniqueSuffix());
    outputInfo = await resolveOutputRoot(requestValue(req, 'outputPath', 'x-output-path'), { create: true });
    outputRoot = outputInfo.path;

    // 🆕 წავიკითხოთ batchId, თუ მოვიდა კლიენტისგან
    batchId = requestValue(req, 'batchId', 'x-upload-batch-id') ? safeName(requestValue(req, 'batchId', 'x-upload-batch-id')) : null; // მაგ. "All_a1b2c3"

    displayBase = safeName(path.basename(originalName, ext)) || `video_${Date.now()}`;

    // 🆕 One folder რეჟიმში მომხმარებლის მიერ ჩაწერილი ფოლდერის სახელი.
    // ერთი ვიდეოზე ცარიელი ველი = ვიდეოს სახელი.
    // რამდენიმე ვიდეოზე ცარიელი ველი = ავტომატური batch სახელი; ჩაწერილი ველი = საერთო ფოლდერის სახელი.
    const rawOutputFolderName = String(requestValue(req, 'outputFolderName') || '').trim();
    const requestedOutputFolderName = rawOutputFolderName ? safeName(rawOutputFolderName) : '';
    const singleVideoFolderName = sameFolder && !batchId
      ? (requestedOutputFolderName || displayBase)
      : '';
    const sharedBatchFolderName = sameFolder && batchId
      ? (requestedOutputFolderName || batchId)
      : '';

    diskBase = safeAsciiForDisk(displayBase);
    videoPath = path.join(uploadsDir, `${sessionId}_${diskBase}_${uniqueSuffix()}${ext}`);

    const stopIfResponseClosed = () => {
      if (!res.writableEnded && sessionId) {
        canceledSessions.add(sessionId);
        setTimeout(() => canceledSessions.delete(sessionId), 10 * 60 * 1000);
        killSessionFfmpeg(sessionId);
      }
    };
    res.once('close', stopIfResponseClosed);

    await video.mv(videoPath);

    let metadata = null;
    let metadataWarning = null;
    try {
      metadata = await ffprobeFile(videoPath);
    } catch (probeErr) {
      if (STRICT_METADATA_READ) throw probeErr;
      const fallback = unknownMetadataFallback(probeErr);
      metadata = fallback.metadata;
      metadataWarning = fallback.warning;
      console.warn(`⚠️ Metadata fallback: ${displayOriginalName || originalName} — ${metadataWarning.detail || metadataWarning.message}`);
    }

    const duration = Number(metadata?.format?.duration);
    const hasKnownDuration = Number.isFinite(duration) && duration > 0;
    if (!hasKnownDuration && !metadataWarning) {
      await cleanupUploadFiles(video, videoPath);
      return sendJsonError(res, 400, 'ხანგრძლივობა ვერ განისაზღვრა.');
    }
    if (hasKnownDuration && startTime >= duration) {
      await cleanupUploadFiles(video, videoPath);
      return sendJsonError(res, 400, 'დაწყების დრო ვიდეოს ხანგრძლივობაზე მეტია.');
    }

    const scaleFilter = buildScalePadFilter(resolution);

    if (!progressState.has(sessionId)) {
      progressState.set(sessionId, { files: {}, folders: [], zipBase: null, outputRoot, outputDisplayPath: outputInfo?.displayPath || outputRoot, outputIsCustom: !outputInfo?.isDefault, updatedAt: Date.now() });
    }

    state = progressState.get(sessionId);
    state.outputRoot = outputRoot;
    state.outputDisplayPath = outputInfo?.displayPath || outputRoot;
    state.outputIsCustom = false;

    // 🆕 ფოლდერის სახელის განსაზღვრა:
    // 1. თუ რამდენიმე ვიდეოა და batchId მოვიდა, ყველა ვიდეო ერთ shared ფოლდერში წავა.
    //    თუ მომხმარებელმა სახელი ჩაწერა, ის სახელი გამოიყენება; თუ არა — All_... batch სახელი.
    // 2. თუ One folder რეჟიმში მხოლოდ ერთი ვიდეოა, ფოლდერს ერქმევა ხელით ჩაწერილი სახელი ან ვიდეოს სახელი.
    // 3. თუ sameFolder === false, ვიყენებთ work_... და ბოლოს ვარქმევთ ვიდეოს სახელს.
    if (batchId) {
      if (state.sharedFolder && await directoryExists(path.join(outputRoot, state.sharedFolder))) {
        workFolderName = state.sharedFolder;
        finalFolderName = state.sharedFolder;
      } else {
        finalFolderName = await uniqueOutputFolderName(sharedBatchFolderName || batchId, outputRoot);
        workFolderName = finalFolderName;
      }
    } else if (sameFolder) {
      finalFolderName = await uniqueOutputFolderName(singleVideoFolderName || displayBase, outputRoot);
      workFolderName = finalFolderName;
    } else {
      workFolderName = `work_${diskBase}_${uniqueSuffix()}`;
      finalFolderName = displayBase; // გადაერქმევა მოგვიანებით
    }

    outputFolder = path.join(outputRoot, workFolderName);
    await fs.mkdir(outputFolder, { recursive: true });

    const captureBase = (sameFolder || batchId) ? `${diskBase}_${uniqueSuffix()}` : diskBase;
    const outputPattern = path.join(outputFolder, `${captureBase}_%05d${SCREENSHOT_EXT}`);

    beforeImgSet = null;
    if (sameFolder || batchId) {
      // თუ ერთ ფოლდერში ვართ, უნდა ვიცოდეთ უკვე არსებული სურათები
      beforeImgSet = new Set();
      const existing = await fs.readdir(outputFolder).catch(() => []);
      existing
        .filter(f => path.extname(f).toLowerCase() === SCREENSHOT_EXT.toLowerCase())
        .forEach(f => beforeImgSet.add(f));
    }

    const safeStartTime = hasKnownDuration
      ? Math.max(0, Math.min(startTime, duration - 0.001))
      : Math.max(0, startTime);
    const effectiveEndTime = hasKnownDuration
      ? ((endTime !== null && endTime > safeStartTime) ? Math.min(endTime, duration) : duration)
      : ((endTime !== null && endTime > safeStartTime) ? endTime : null);
    const unknownDurationWithoutEnd = !hasKnownDuration && effectiveEndTime === null;
    const segmentDuration = unknownDurationWithoutEnd
      ? null
      : Math.max(0.001, effectiveEndTime - safeStartTime);
    const captureTimes = unknownDurationWithoutEnd
      ? []
      : buildCaptureTimes(safeStartTime, segmentDuration, interval);

    const fpsExpr = buildFpsExpression(interval);
    const totalShots = unknownDurationWithoutEnd ? UNKNOWN_DURATION_MAX_SCREENSHOTS : captureTimes.length;
    if (totalShots > MAX_SCREENSHOTS_PER_VIDEO) {
      await cleanupUploadFiles(video, videoPath);
      return sendJsonError(res, 400, `ძალიან ბევრი სქრინშოტი გამოვა (${totalShots}). გაზარდე ინტერვალი ან შეამცირე დროის დიაპაზონი.`, { totalShots, max: MAX_SCREENSHOTS_PER_VIDEO });
    }

    const outputDims = selectedResolutionSizeServer(metadata, resolution);
    const requiredMemoryBytes = estimateProcessingMemoryBytes(outputDims.width, outputDims.height);
    const estimatedImageBytes = totalShots * estimatePngBytesServer(outputDims.width, outputDims.height);
    let capacityCheck = await checkRuntimeCapacity({ estimatedBytes: estimatedImageBytes, estimatedScreenshots: totalShots, outputRoot, requiredMemoryBytes });
    if (!capacityCheck.enough) {
      await cleanupUploadFiles(video, videoPath);
      throw capacityError(507, capacityCheck);
    }
    const diskCheck = capacityCheck.disk;
    const memoryCheck = capacityCheck.memory;
    const useSparseExtract = !unknownDurationWithoutEnd && interval >= 10 && totalShots <= 300;

    if ((sameFolder || batchId) && !state.sharedFolder) state.sharedFolder = workFolderName;
    if (!Array.isArray(state.folders)) state.folders = [];
    if (!state.folders.includes(workFolderName)) state.folders.push(workFolderName);

    const zipBaseForThisUpload = (batchId || sameFolder) ? finalFolderName : displayBase;
    if (!state.zipBase) {
      state.zipBase = zipBaseForThisUpload;
    } else if (state.zipBase !== zipBaseForThisUpload && !String(state.zipBase).startsWith('batch_') && !String(state.zipBase).startsWith('All_')) {
      state.zipBase = `batch_${sessionId}`;
    }

    fileKey = `${diskBase}_${uniqueSuffix()}`;
    state.files[fileKey] = {
      filename: displayOriginalName || originalName,
      percent: 0,
      timemark: '00:00:00.00',
      status: 'queued',
      duration: segmentDuration,
      interval,
      expectedScreenshots: totalShots,
      estimatedImageBytes,
      estimatedImageSize: formatBytesServer(estimatedImageBytes),
      outputResolution: `${outputDims.width}x${outputDims.height} native/original`,
      metadataWarning,
      requiredMemorySize: memoryCheck.requiredText,
      requiredDiskSize: diskCheck.requiredText,
      freeDiskSize: diskCheck.freeText,
      freeMemorySize: memoryCheck.freeText,
      outputPath: outputInfo?.displayPath || outputRoot,
      startTime: safeStartTime,
      endTime: effectiveEndTime,
      folder: finalFolderName
    };
    state.updatedAt = Date.now();

    console.log(`▶️ დაიწყო სქრინშოტების გენერაცია: ${displayBase} (${sessionId}) - folder: ${workFolderName}, interval: ${interval}s, expected: ${totalShots}, output: ${outputDims.width}x${outputDims.height} native/original, resizeLocked: ${NATIVE_ORIGINAL_OUTPUT_LOCKED}`);

    await waitWhilePaused(sessionId);
    if (stopCurrentRequests.has(sessionId)) {
      stopCurrentRequests.delete(sessionId);
      rememberForcedFileStop(sessionId, fileKey, 'stopped_current', 'მიმდინარე ვიდეო შეჩერდა. Batch გაგრძელდება შემდეგ ვიდეოზე.');
      throw createHttpError(409, 'მიმდინარე ვიდეო შეჩერდა.', { reason: 'stopped_current' });
    }
    await acquireJobSlot();
    slotAcquired = true;

    if (canceledSessions.has(sessionId)) {
      throw createHttpError(499, 'დამუშავება შეწყდა.', { reason: 'canceled_while_queued' });
    }

    capacityCheck = await checkRuntimeCapacity({ estimatedBytes: estimatedImageBytes, estimatedScreenshots: totalShots, outputRoot, requiredMemoryBytes });
    if (!capacityCheck.enough) {
      throw capacityError(507, capacityCheck);
    }

    const stAfterSlot = progressState.get(sessionId);
    if (stAfterSlot?.files?.[fileKey]) {
      stAfterSlot.files[fileKey].status = 'processing';
      stAfterSlot.updatedAt = Date.now();
      broadcast(sessionId, { type: 'start', file: stAfterSlot.files[fileKey], fileKey });
    }

    const progressDuration = unknownDurationWithoutEnd
      ? Math.max(1, totalShots * interval)
      : (segmentDuration || duration || Math.max(1, totalShots * interval));

    if (useSparseExtract) {
      // ... (sparse extraction code - იგივე რჩება)
      const times = captureTimes;
      const total = Math.max(1, times.length);

      for (let i = 0; i < times.length; i++) {
        if (canceledSessions.has(sessionId)) {
          const err = new Error('canceled');
          err.code = 'CANCELED';
          throw err;
        }
        if (stopCurrentRequests.has(sessionId)) {
          stopCurrentRequests.delete(sessionId);
          rememberForcedFileStop(sessionId, fileKey, 'stopped_current', 'მიმდინარე ვიდეო შეჩერდა. Batch გაგრძელდება შემდეგ ვიდეოზე.');
          throw createHttpError(409, 'მიმდინარე ვიდეო შეჩერდა.', { reason: 'stopped_current' });
        }

        if (i === 0 || i % 10 === 0) {
          const remainingBytes = Math.max(estimatePngBytesServer(outputDims.width, outputDims.height), (total - i) * estimatePngBytesServer(outputDims.width, outputDims.height));
          const diskGuard = await checkDiskDuringProcessing(sessionId, fileKey, remainingBytes, outputRoot);
          if (!diskGuard.ok) {
            rememberForcedFileStop(sessionId, fileKey, diskGuard.reason, diskGuard.message, { disk: diskGuard.disk });
            throw createHttpError(507, diskGuard.message, { reason: diskGuard.reason, disk: diskGuard.disk });
          }
        }

        const t = times[i];
        const outFile = path.join(outputFolder, `${captureBase}_${String(i + 1).padStart(5, '0')}${SCREENSHOT_EXT}`);

        await new Promise((resolve, reject) => {
          command = ffmpeg(videoPath)
            .seekInput(t)
            .outputOptions(makeSparseOutputOptions(scaleFilter))
            .output(outFile);

          trackFfmpeg(sessionId, command, fileKey);

          command
            .on('error', err => {
              const forced = peekForcedFileStop(sessionId, fileKey);
              const wasCanceled = canceledSessions.has(sessionId) || forced?.reason === 'canceled_session';
              logFfmpegStopOrError('FFmpeg snapshot', err, forced, sessionId);
              untrackFfmpeg(sessionId, command, fileKey);

              const st = progressState.get(sessionId);
              if (st?.files[fileKey]) {
                st.files[fileKey].status = statusFromForcedStop(forced, wasCanceled);
                st.files[fileKey].error = String(forced?.message || err.message || err);
                st.updatedAt = Date.now();
                broadcastTerminalState(sessionId, fileKey, st.files[fileKey]);
              }
              reject(err);
            })
            .on('end', () => {
              untrackFfmpeg(sessionId, command, fileKey);
              resolve();
            })
            .run();
        });

        const st = progressState.get(sessionId);
        if (st?.files[fileKey]) {
          st.files[fileKey].percent = Math.round(((i + 1) / total) * 100 * 10) / 10;
          st.files[fileKey].timemark = secondsToTimemark(Math.min((t - safeStartTime), progressDuration));
          st.updatedAt = Date.now();
          broadcast(sessionId, { type: 'progress', fileKey, ...st.files[fileKey] });
        }
      }

      await cleanupUploadFiles(video, videoPath);

      const st = progressState.get(sessionId);
      if (st?.files[fileKey]) {
        st.files[fileKey].percent = 100;
        st.files[fileKey].status = 'done';
        st.updatedAt = Date.now();
        broadcast(sessionId, { type: 'done', fileKey, ...st.files[fileKey] });
      }

      if (slotAcquired) {
        releaseJobSlot();
        slotAcquired = false;
      }

    } else {
      // Standard extraction: force the exact interval from the UI.
      // -frames:v caps the count to the same value used by the estimator, so 2 sec can never silently become 1 sec.
      const vfFilter = [
        'setpts=PTS-STARTPTS',
        `fps=fps=${fpsExpr}:start_time=0:round=near:eof_action=pass`,
        ...(scaleFilter ? [scaleFilter] : [])
      ].join(',');

      const ffmpegOutputOptions = [
        ...(unknownDurationWithoutEnd ? [] : ['-t', String(segmentDuration)]),
        '-vf', vfFilter,
        '-sws_flags', SWS_QUALITY_FLAGS,
        '-fps_mode', 'vfr',
        '-frames:v', String(totalShots),
        '-start_number', '1',
        '-an',
        '-vcodec', 'png',
        '-pix_fmt', PNG_PIXEL_FORMAT,
        '-compression_level', String(PNG_COMPRESSION_LEVEL),
      ];

      command = ffmpeg(videoPath)
        .seekInput(safeStartTime)
        .outputOptions(ffmpegOutputOptions)
        .output(outputPattern);

      let lastDiskGuardAt = 0;
      let diskGuardInFlight = false;

      await new Promise((resolve, reject) => {
        trackFfmpeg(sessionId, command, fileKey);

        command
          .on('progress', p => {
            const current = Math.min(parseTimemark(p.timemark || '0:00:00.00'), progressDuration);
            const percent = Math.max(0, Math.min(100, (current / progressDuration) * 100));

            const now = Date.now();
            if (!diskGuardInFlight && now - lastDiskGuardAt >= LOW_DISK_CHECK_INTERVAL_MS) {
              lastDiskGuardAt = now;
              diskGuardInFlight = true;
              const remainingRatio = Math.max(0.05, 1 - (percent / 100));
              const remainingBytes = Math.ceil(estimatedImageBytes * remainingRatio);
              checkDiskDuringProcessing(sessionId, fileKey, remainingBytes, outputRoot)
                .then(guard => {
                  if (!guard.ok) {
                    rememberForcedFileStop(sessionId, fileKey, guard.reason, guard.message, { disk: guard.disk });
                    try { command.kill('SIGKILL'); } catch {}
                  }
                })
                .catch(err => console.warn('Disk guard check failed:', err?.message || err))
                .finally(() => { diskGuardInFlight = false; });
            }

            const st = progressState.get(sessionId);
            if (st?.files[fileKey]) {
              st.files[fileKey].percent = Math.round(percent * 10) / 10;
              st.files[fileKey].timemark = p.timemark || '00:00:00.00';
              st.updatedAt = Date.now();
              broadcast(sessionId, { type: 'progress', fileKey, ...st.files[fileKey] });
            }
          })
          .on('error', async err => {
            const forced = peekForcedFileStop(sessionId, fileKey);
            const wasCanceled = canceledSessions.has(sessionId) || forced?.reason === 'canceled_session';
            logFfmpegStopOrError('FFmpeg', err, forced, sessionId);

            untrackFfmpeg(sessionId, command, fileKey);

            await cleanupUploadFiles(video, videoPath);

            const st = progressState.get(sessionId);
            if (st?.files[fileKey]) {
              st.files[fileKey].status = statusFromForcedStop(forced, wasCanceled);
              st.files[fileKey].error = String(forced?.message || err.message || err);
              st.updatedAt = Date.now();
              broadcastTerminalState(sessionId, fileKey, st.files[fileKey]);
            }

            if (slotAcquired) {
              releaseJobSlot();
              slotAcquired = false;
            }
            reject(err);
          })
          .on('end', async () => {
            untrackFfmpeg(sessionId, command, fileKey);

            await cleanupUploadFiles(video, videoPath);

            const st = progressState.get(sessionId);
            if (st?.files[fileKey]) {
              st.files[fileKey].percent = 100;
              st.files[fileKey].status = 'done';
              st.files[fileKey].timemark = secondsToTimemark(progressDuration);
              st.updatedAt = Date.now();
              broadcast(sessionId, { type: 'done', fileKey, ...st.files[fileKey] });
            }

            console.log(`✅ დასრულდა სქრინშოტების გენერაცია: ${displayBase} (${sessionId})`);

            if (slotAcquired) {
              releaseJobSlot();
              slotAcquired = false;
            }
            resolve();
          })
          .run();
      });
    }

    // Post-processing: წარმატებით დასრულების შემდეგაც და partial finalize-შიც ერთი და იგივე ლოგიკაა
    finalizedOutput = await finalizeScreenshotOutput({
      sessionId,
      fileKey,
      workFolderName,
      finalFolderName,
      outputFolder,
      displayBase,
      beforeImgSet,
      sameFolder,
      batchId,
      outputRoot
    });

    const folderForClient = finalizedOutput?.folderForClient || ((sameFolder || batchId) ? workFolderName : finalFolderName);
    const screenshots = finalizedOutput?.screenshots || [];
    const imageBytes = finalizedOutput?.finalFolderPath
      ? (await imageStatsInFolder(finalizedOutput.finalFolderPath)).bytes
      : 0;

    const actualNewScreenshots = Number(finalizedOutput?.newImageCount || 0);
    res.json({
      message: `${displayBase} → ამ ვიდეოდან გენერირებულია ${actualNewScreenshots} სქრინშოტი / ფოლდერში ჯამში ${screenshots.length}${imageBytes ? ` / ${formatBytesServer(imageBytes)}` : ''}.`,
      screenshots,
      imageBytes,
      imageSize: formatBytesServer(imageBytes),
      appliedInterval: interval,
      expectedScreenshots: totalShots,
      estimatedImageBytes,
      estimatedImageSize: formatBytesServer(estimatedImageBytes),
      outputResolution: `${outputDims.width}x${outputDims.height} native/original`,
      metadataWarning,
      requiredMemorySize: memoryCheck.requiredText,
      requiredDiskSize: diskCheck.requiredText,
      actualNewScreenshots,
      folderScreenshots: screenshots.length,
      sessionId,
      fileKey,
      folder: folderForClient
    });

  } catch (err) {
    const forced = takeForcedFileStop(sessionId, fileKey);
    const wasCanceled = err?.code === 'CANCELED' || (sessionId && canceledSessions.has(sessionId)) || forced?.reason === 'canceled_session' || /canceled/i.test(String(err?.message || err));
    const wasStoppedOnly = forced?.reason === 'stopped_current';
    const wasLowDisk = forced?.reason === 'low_disk_during_process';
    if (isExpectedUserStop(err, forced, sessionId)) {
      console.log('⏹️ Upload stopped by user:', forced?.message || err?.message || err);
    } else {
      console.error('Upload Error:', forced?.message || err);
    }

    if (command) untrackFfmpeg(sessionId, command, fileKey);
    if (slotAcquired) releaseJobSlot();

    let partialOutput = null;
    try {
      if (!finalizedOutput && outputFolder && displayBase && (await countImagesInFolder(outputFolder)) > 0) {
        partialOutput = await finalizeScreenshotOutput({
          sessionId,
          fileKey,
          workFolderName,
          finalFolderName,
          outputFolder,
          displayBase,
          beforeImgSet,
          sameFolder,
          batchId,
          outputRoot
        });
      }
    } catch (finalizeErr) {
      console.error('Partial finalize error:', finalizeErr);
    }

    await cleanupUploadFiles(video, videoPath);

    const st = sessionId ? progressState.get(sessionId) : null;
    if (st?.files?.[fileKey]) {
      st.files[fileKey].status = statusFromForcedStop(forced, wasCanceled);
      st.files[fileKey].error = String(forced?.message || err?.message || err);
      st.files[fileKey].partialSaved = Boolean(partialOutput?.imageCount);
      if (partialOutput?.folderForClient) st.files[fileKey].folder = partialOutput.folderForClient;
      if (partialOutput?.imageCount) st.files[fileKey].screenshots = partialOutput.imageCount;
      st.updatedAt = Date.now();
      broadcastTerminalState(sessionId, fileKey, st.files[fileKey]);
    }

    if (wasStoppedOnly && !res.headersSent && !res.writableEnded && !res.destroyed) {
      return res.status(200).json({
        message: `${displayBase || originalName || 'video'} → მიმდინარე ვიდეო შეჩერდა. Batch გაგრძელდა შემდეგ ვიდეოზე.`,
        stopped: true,
        partialSaved: Boolean(partialOutput?.imageCount),
        screenshots: partialOutput?.screenshots || [],
        sessionId,
        fileKey,
        folder: partialOutput?.folderForClient || null
      });
    }

    if (partialOutput?.imageCount && !wasLowDisk && !res.headersSent && !res.writableEnded && !res.destroyed) {
      return res.status(200).json({
        message: `${displayBase || originalName || 'video'} → დამუშავება შეწყდა, მაგრამ შენახულია ${partialOutput.imageCount} სქრინშოტი.`,
        partialSaved: true,
        screenshots: partialOutput.screenshots,
        sessionId,
        fileKey,
        folder: partialOutput.folderForClient
      });
    }

    if (!res.headersSent && !res.writableEnded && !res.destroyed) {
      const statusCode = wasCanceled ? 499 : (Number(err?.statusCode) || 500);
      return res.status(statusCode).json({
        error: forced?.message || (wasCanceled ? 'დამუშავება შეწყდა.' : (err?.publicMessage || err?.message || 'დამუშავების შეცდომა.')),
        partialSaved: false,
        ...(err?.extra || {}),
        ...(forced?.extra || {}),
      });
    }
  }
});

// ===== Periodic Cleanup =====
setInterval(async () => {
  try {
    const now = Date.now();
    const maxAge = CLEANUP_MAX_AGE_MS;

    const cleanDir = async (dir) => {
      const items = await fs.readdir(dir).catch(() => []);

      await Promise.all(items.map(async item => {
        const full = path.join(dir, item);
        try {
          const stat = await fs.stat(full);
          if (now - stat.mtimeMs > maxAge) {
            await fs.rm(full, { recursive: true, force: true });
            console.log(`🧹 წაშლილია: ${fixGeorgianLetters(item)}`);
          }
        } catch {}
      }));
    };

    await Promise.all([
      cleanDir(uploadsDir),
      cleanDir(tempDir)
    ]);

    for (const [sid, st] of progressState.entries()) {
      if (now - (st.updatedAt || 0) > 12 * 60 * 60 * 1000) {
        progressState.delete(sid);
      }
    }
  } catch (err) {
    console.error('Cleanup Error:', err);
  }
}, CLEANUP_SCAN_INTERVAL_MS);

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('SIGINT', () => {
  for (const sid of Array.from(runningFfmpeg.keys())) killSessionFfmpeg(sid);
  process.exit(0);
});
process.on('SIGTERM', () => {
  for (const sid of Array.from(runningFfmpeg.keys())) killSessionFfmpeg(sid);
  process.exit(0);
});

// ===== Server Start =====
const PORT = Number(process.env.PORT || 3004);
const HOST = process.env.HOST || '0.0.0.0';

async function startServer() {
  await ensureRuntimeFolders();

  const server = app.listen(PORT, HOST, () => {
    const networkInterfaces = os.networkInterfaces();
    let localIp = 'localhost';

    for (const interfaceName in networkInterfaces) {
      for (const iface of networkInterfaces[interfaceName]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          localIp = iface.address;
        }
      }
    }

    console.log('\n🚀 სერვერი წარმატებით გაეშვა!');
    console.log('-------------------------------------------');
    console.log(`🏠 ლოკალური წვდომა: http://localhost:${PORT}`);
    console.log(`📱 ქსელური წვდომა (WiFi): http://${localIp}:${PORT}`);
    console.log('-------------------------------------------\n');
    console.log('📂 ნაგულისხმევი შენახვის საქაღალდე: ' + outputDir);
    console.log('📁 custom output picker: ' + (ENABLE_CUSTOM_OUTPUT ? 'enabled' : 'disabled'));
  });

  server.on('error', (err) => {
    console.error('❌ სერვერის listen შეცდომა:', err);
    process.exit(1);
  });
}

startServer().catch((err) => {
  console.error('❌ სერვერის გაშვების შეცდომა:', err);
  process.exit(1);
});