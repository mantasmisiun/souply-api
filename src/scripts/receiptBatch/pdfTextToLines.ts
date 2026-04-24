/**
 * Extract `Line[]` ({ text, yTop, yBottom, xLeft, xRight }) from a PDF
 * by shelling out to `pdftotext -bbox-layout`. Output shape matches the
 * `MaximaLine` / `RimiLine` / `IkiLine` interfaces the shared parsers
 * expect, so we can feed PDF receipts through the same code MLKit-OCR
 * output would flow through on the phone.
 *
 * Assumptions:
 *  - `pdftotext` from poppler-utils is on PATH (Ubuntu: `apt install
 *    poppler-utils`).
 *  - Input PDF has embedded text. Scanned image-PDFs produce zero
 *    `<line>` elements; the caller should treat an empty result as
 *    "not text-extractable" and route to the image pipeline.
 *
 * Why regex-parse instead of a real XML lib: the bbox-layout output is
 * a constrained subset we control — pure `<line …>…<word …>text</word>
 * …</line>` with numeric attributes. Dragging in `xmldom`/`fast-xml-
 * parser` just for this dev script isn't worth the dependency.
 */

import { spawnSync } from 'child_process';

export interface ExtractedLine {
    text: string;
    yTop: number;
    yBottom: number;
    xLeft: number;
    xRight: number;
}

export interface PdfExtractionResult {
    lines: ExtractedLine[];
    /** Page dimensions from the first page — used only for debugging/logs. */
    pageWidth: number;
    pageHeight: number;
}

const LINE_RE =
    /<line\s+xMin="([\d.]+)"\s+yMin="([\d.]+)"\s+xMax="([\d.]+)"\s+yMax="([\d.]+)"\s*>([\s\S]*?)<\/line>/g;
const WORD_RE = /<word\s+[^>]*>([\s\S]*?)<\/word>/g;
const PAGE_RE = /<page\s+width="([\d.]+)"\s+height="([\d.]+)"/;

const decodeEntities = (s: string): string =>
    s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));

export const extractLinesFromPdf = async (pdfPath: string): Promise<PdfExtractionResult> => {
    // -bbox-layout emits XHTML with page/block/line/word elements, each
    // tagged with xMin/yMin/xMax/yMax. For our purposes we collapse to
    // <line> granularity — the parsers operate on whole lines, not
    // individual words.
    const res = spawnSync('pdftotext', ['-bbox-layout', pdfPath, '-'], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
    });
    if (res.status !== 0) {
        throw new Error(
            `pdftotext failed for ${pdfPath} (status=${res.status}): ${res.stderr?.slice(0, 300) ?? ''}`
        );
    }

    const xhtml = res.stdout;
    const pageMatch = PAGE_RE.exec(xhtml);
    const pageWidth = pageMatch ? parseFloat(pageMatch[1]) : 0;
    const pageHeight = pageMatch ? parseFloat(pageMatch[2]) : 0;

    const lines: ExtractedLine[] = [];
    LINE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LINE_RE.exec(xhtml)) !== null) {
        const xLeft = parseFloat(m[1]);
        const yTop = parseFloat(m[2]);
        const xRight = parseFloat(m[3]);
        const yBottom = parseFloat(m[4]);
        const inner = m[5];

        const words: string[] = [];
        WORD_RE.lastIndex = 0;
        let wm: RegExpExecArray | null;
        while ((wm = WORD_RE.exec(inner)) !== null) {
            words.push(decodeEntities(wm[1]));
        }
        const text = words.join(' ').trim();
        if (!text) continue;
        lines.push({ text, yTop, yBottom, xLeft, xRight });
    }

    // Parsers assume top-to-bottom, left-to-right ordering. bbox-layout
    // usually emits in reading order already but cheap to sort anyway.
    lines.sort((a, b) => a.yTop - b.yTop || a.xLeft - b.xLeft);

    return { lines, pageWidth, pageHeight };
};
