import type { LabelFileType } from '../../../shared/model.ts';
import { parseJson, type CallRecord } from './types.ts';

// The exact shape of the step 3 response is not confirmed yet, so these helpers search it
// tolerantly. Every step 3 response is stored in api_calls so the structure can be checked.

const FILENAME_KEYS = /^(label)?file_?name$|^filename$|^labelname$|^name$/i;

/** Finds the label FILENAME in the step 3 response, exactly as Monta returns it (e.g. "…_Label_1_….txt" for ZPL). */
export function extractFileName(responseText: string, type: LabelFileType): string | null {
  const data = parseJson(responseText);
  const ext = new RegExp(`\\.${type}$`, 'i');

  if (typeof data === 'string' && data.trim()) return data.trim();

  let byKey: string | null = null;
  let byExt: string | null = null;
  const walk = (v: unknown) => {
    if (byKey) return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        if (typeof val === 'string' && val.trim()) {
          if (FILENAME_KEYS.test(k)) { byKey = val.trim(); return; }
          if (!byExt && ext.test(val.trim()) && !val.includes('/')) byExt = val.trim();
        } else walk(val);
      }
    }
  };
  walk(data);
  const found = byKey ?? byExt;
  return found;
}

const looksLikeLabel = (b: Buffer, type: LabelFileType) =>
  type === 'pdf' ? b.subarray(0, 5).toString('latin1') === '%PDF-' : /\^XA/.test(b.subarray(0, 200).toString('latin1'));

/** Gets the label bytes from the step 4 response: raw file, or base64 inside JSON. */
export function extractLabelBytes(call: CallRecord, type: LabelFileType): Buffer | null {
  if (!call.bytes?.length) return null;
  if (looksLikeLabel(call.bytes, type)) return call.bytes;

  const data = parseJson(call.responseBody);
  if (data === undefined) {
    // ZPL served as plain text without ^XA in the first bytes is still accepted as-is.
    return type === 'zpl' && !/json|html/i.test(call.contentType ?? '') ? call.bytes : null;
  }
  let found: Buffer | null = null;
  const walk = (v: unknown) => {
    if (found) return;
    if (typeof v === 'string' && v.length > 40) {
      const b = Buffer.from(v, 'base64');
      if (looksLikeLabel(b, type)) found = b;
      else if (type === 'zpl' && /\^XA/.test(v)) found = Buffer.from(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(data);
  return found;
}
