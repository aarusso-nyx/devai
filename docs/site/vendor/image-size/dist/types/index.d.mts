import { IImage } from './interface.mjs';

declare const typeHandlers: Map<"heif" | "icns" | "ktx" | "tiff" | "bmp" | "cur" | "dds" | "gif" | "ico" | "j2c" | "jp2" | "jpg" | "jxl" | "jxl-stream" | "png" | "pnm" | "psd" | "svg" | "tga" | "webp", IImage>;
declare const types: ("heif" | "icns" | "ktx" | "tiff" | "bmp" | "cur" | "dds" | "gif" | "ico" | "j2c" | "jp2" | "jpg" | "jxl" | "jxl-stream" | "png" | "pnm" | "psd" | "svg" | "tga" | "webp")[];
type imageType = (typeof types)[number];

export { type imageType, typeHandlers, types };
