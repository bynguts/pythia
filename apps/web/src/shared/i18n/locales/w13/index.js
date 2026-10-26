// Wave 13 per-lane catalogs. Each lane owns one pair of files, <lane>.en.js and
// <lane>.id.js, exporting a named object (`<lane>En`, `<lane>Id`) whose keys carry
// the lane prefix (`s1_needs_you_title`). The pairs merge here and then over the
// base catalogs in ../../index.jsx, so a lane never edits en.js / id.js.
import { d1En } from "./d1.en.js";
import { d1Id } from "./d1.id.js";
import { d2En } from "./d2.en.js";
import { d2Id } from "./d2.id.js";
import { fEn } from "./f.en.js";
import { fId } from "./f.id.js";
import { lEn } from "./l.en.js";
import { lId } from "./l.id.js";
import { olEn } from "./ol.en.js";
import { olId } from "./ol.id.js";
import { s1En } from "./s1.en.js";
import { s1Id } from "./s1.id.js";
import { s2En } from "./s2.en.js";
import { s2Id } from "./s2.id.js";
import { s3En } from "./s3.en.js";
import { s3Id } from "./s3.id.js";
import { s4En } from "./s4.en.js";
import { s4Id } from "./s4.id.js";
import { s5En } from "./s5.en.js";
import { s5Id } from "./s5.id.js";
import { slEn } from "./sl.en.js";
import { slId } from "./sl.id.js";
import { ocEn } from "./oc.en.js";
import { ocId } from "./oc.id.js";
import { nsEn } from "./ns.en.js";
import { nsId } from "./ns.id.js";

export const w13En = {
  ...fEn,
  ...lEn,
  ...d1En,
  ...d2En,
  ...s1En,
  ...s2En,
  ...s3En,
  ...s4En,
  ...s5En,
  ...olEn,
  ...slEn,
  ...ocEn,
  ...nsEn,
};
export const w13Id = {
  ...fId,
  ...lId,
  ...d1Id,
  ...d2Id,
  ...s1Id,
  ...s2Id,
  ...s3Id,
  ...s4Id,
  ...s5Id,
  ...olId,
  ...slId,
  ...ocId,
  ...nsId,
};
