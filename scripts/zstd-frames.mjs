/**
 * 拼接 Zstandard 帧的走查与解压（独立实现，按 RFC 8878 的 Frame_Header / Data_Block 结构）。
 *
 * 为什么需要它：DSH 把一个会话的日志写成「一个持久批次 = 一个 zstd 帧」的**拼接**文件
 * （`session.vN.jsonl.zstd`）。而 `node:zlib` 的 `zstdDecompressSync` 与 `createZstdDecompress`
 * 都**只解第一帧**（实测：325224 字节的文件只解出 325 字节 / 1 行，真值是 206 帧 / 1193527 字节）。
 * 所以必须自己按帧头算出边界，再逐帧解压。
 *
 * 结构（RFC 8878 §3）：
 *   Magic(4) = 28 B5 2F FD
 *   Frame_Header_Descriptor(1)  bit7-6 内容长度字段宽度 / bit5 单段标志 / bit4 未用(须为0)
 *                              bit3 保留(须为0) / bit2 校验和标志 / bit1-0 字典 ID 宽度
 *   [Window_Descriptor(1)]      仅当「单段标志」为 0
 *   [Dictionary_ID(0/1/2/4)]
 *   [Frame_Content_Size(0/1/2/4/8)]
 *   Data_Block*                 每块 3 字节头：bit0 末块 / bit1-2 块类型 / bit3-23 块大小
 *   [Content_Checksum(4)]       仅当校验和标志为 1
 */

import { promisify } from 'node:util';
import { zstdDecompress } from 'node:zlib';

const zstdDecompressAsync = promisify(zstdDecompress);

/** `0xFD2FB528` 的小端字节序。 */
export const ZSTD_MAGIC = 0xfd2fb528;

/** 单帧的块类型。 */
const BLOCK_RAW = 0;
const BLOCK_RLE = 1;
const BLOCK_COMPRESSED = 2;
const BLOCK_RESERVED = 3;

/**
 * 算出从 `start` 开始的一帧在哪里结束。
 * @returns {number|null} 结束偏移（不含）；数据不完整时返回 null（调用方据此判定「末帧被撕裂」）。
 */
function frameEnd(buffer, start) {
  let offset = start;
  if (buffer.length - offset < 4) return null;
  if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
    throw new Error(`不是合法的 Zstandard 会话日志：偏移 ${offset} 处的帧魔数不对`);
  }
  offset += 4;
  if (offset >= buffer.length) return null;

  const descriptor = buffer[offset];
  offset += 1;
  if ((descriptor & 0x08) !== 0) throw new Error(`帧头保留位非 0（偏移 ${offset - 1}）`);
  if ((descriptor & 0x10) !== 0) throw new Error(`帧头未用位非 0（偏移 ${offset - 1}）`);

  const contentSizeFlag = descriptor >> 6;
  const singleSegment = (descriptor & 0x20) !== 0;
  const hasChecksum = (descriptor & 0x04) !== 0;
  const dictionaryFlag = descriptor & 0x03;

  if (!singleSegment) offset += 1; // Window_Descriptor
  offset += dictionaryFlag === 0 ? 0 : dictionaryFlag === 1 ? 1 : dictionaryFlag === 2 ? 2 : 4;
  offset += contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : contentSizeFlag === 1 ? 2 : contentSizeFlag === 2 ? 4 : 8;
  if (offset > buffer.length) return null;

  let last = false;
  while (!last) {
    if (buffer.length - offset < 3) return null;
    const header = buffer.readUIntLE(offset, 3);
    offset += 3;
    last = (header & 1) === 1;
    const blockType = (header >> 1) & 0x03;
    const blockSize = header >>> 3;
    if (blockType === BLOCK_RESERVED) throw new Error(`帧内出现保留块类型（偏移 ${offset - 3}）`);
    // RLE 块的「数据」只有 1 字节；RAW/COMPRESSED 是 blockSize 字节。
    offset += blockType === BLOCK_RLE ? 1 : blockSize;
    if (offset > buffer.length) return null;
  }

  if (hasChecksum) {
    offset += 4;
    if (offset > buffer.length) return null;
  }
  return offset;
}

/**
 * 走查整个缓冲区里的所有拼接帧。
 * @param {Buffer} buffer
 * @param {{maxFrames?: number}} [options]
 * @returns {{frames: Array<{start:number,end:number}>, tornStart?: number}}
 *   `tornStart` 存在表示尾部有一帧不完整（写入过程中的撕裂帧），其完整解码内容仍然可用。
 */
export function scanFrames(buffer, options = {}) {
  const maxFrames = options.maxFrames ?? Number.POSITIVE_INFINITY;
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    let end;
    try {
      end = frameEnd(buffer, offset);
    } catch (error) {
      if (frames.length === 0) throw error;
      return { frames, tornStart: offset };
    }
    if (end === null) return frames.length === 0 ? { frames } : { frames, tornStart: offset };
    frames.push({ start: offset, end });
    offset = end;
    if (frames.length >= maxFrames) break;
  }
  return { frames };
}

/**
 * 逐帧解压并拼接。
 * @param {Buffer} buffer
 * @param {{maxFrames?: number, maxOutputLength?: number}} [options]
 * @returns {Promise<{content: Buffer, frameCount: number, torn: boolean, decodedBytes: number}>}
 */
export async function decompressFrames(buffer, options = {}) {
  const { frames, tornStart } = scanFrames(buffer, options);
  const parts = [];
  for (const frame of frames) {
    const slice = buffer.subarray(frame.start, frame.end);
    const decoded = options.maxOutputLength === undefined
      ? await zstdDecompressAsync(slice)
      : await zstdDecompressAsync(slice, { maxOutputLength: options.maxOutputLength });
    parts.push(Buffer.isBuffer(decoded) ? decoded : Buffer.from(decoded));
  }
  const content = Buffer.concat(parts);
  return { content, frameCount: frames.length, torn: tornStart !== undefined, decodedBytes: content.length };
}
