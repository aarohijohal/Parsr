/**
 * Copyright 2019 AXA Group Operations S.A.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as limit from 'limit-async';
import * as pdfjs from 'pdfjs-dist';
import { BoundingBox, Document, Font, Page, Word } from '../../types/DocumentRepresentation';
import * as CommandExecuter from '../../utils/CommandExecuter';
import logger from '../../utils/Logger';

/**
 * Executes the pdfjs extraction function, reading an input pdf file and extracting a document representation.
 * This function involves recovering page contents like words, bounding boxes, fonts and other information that
 * the pdfjs tool's output provides.
 *
 * @param pdfInputFile The path including the name of the pdf file for input.
 * @returns The promise of a valid document (in the format DocumentRepresentation).
 */

// this is for limiting page fetching to 10 at the same time and avoid memory overflows
const limiter = limit(10);

const rgbToHex = (r, g, b) =>
  '#' +
  [r, g, b]
    .map(x => {
      const hex = x.toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    })
    .join('');

export function execute(pdfInputFile: string): Promise<Document> {
  logger.info('Running extractor PDF.js');
  const startTime: number = Date.now();

  return new Promise<Document>((resolveDocument, rejectDocument) => {
    return CommandExecuter.repairPdf(pdfInputFile).then((repairedPdf: string) => {
      const pages: Array<Promise<Page>> = [];
      try {
        return (pdfjs.getDocument(repairedPdf) as any).promise.then(doc => {
          const numPages = doc.numPages;
          for (let i = 0; i < numPages; i += 1) {
            pages.push(limiter(loadPage)(doc, i + 1));
          }
          return Promise.all(pages).then((p: Page[]) => {
            const endTime: number = (Date.now() - startTime) / 1000;
            logger.info(`  Elapsed time: ${endTime}s`);
            resolveDocument(new Document(p, repairedPdf));
          });
        });
      } catch (e) {
        return rejectDocument(e);
      }
    });
  });
}

async function loadPage(document: any, pageNum: number): Promise<Page> {
  const page = await document.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1.0 });
  const textContent = await page.getTextContent({
    normalizeWhitespace: true,
  });

  const pageElements: Word[] = [];
  const fontStyles = textContent.styles;
  /*
    each 'item.str' returned by pdf.js can be a string with multiple words and even have a splitted word.
    for this reason, we:
      - split the 'item.str' into words,
      - calculate each single word's BBox,
      - search for splitted words to join them together

      MAtrix reference on page 142 of PDF doc
      https://via.hypothes.is/https://www.adobe.com/content/dam/acom/en/devnet/pdf/pdfs/pdf_reference_archives/
      PDFReference.pdf#annotations:SVudloF5EemLBgPm0gmY3Q
  */
  textContent.items.forEach(item => {
    const text = item.str;
    if (text.length > 0) {
      const transform = (pdfjs.Util as any).transform(viewport.transform, item.transform);
      // trying to fix some case where pdf.js switch bounding box coordinates
      if (item.width < 0) {
        item.width = -item.width;
      }
      const f = fontStyles[item.fontName];
      const font = new Font([f.fontName, f.fontFamily].join(','), transform[0], {
        isItalic: f.italic,
        weight: f.bold ? 'bold' : 'normal',
        color: rgbToHex(item.color[0], item.color[1], item.color[2]),
      });
      const words = text.split(' ');
      let wordLeft = transform[4];
      const avgCharWidth = item.width / text.length;
      words.forEach(word => {
        const wordWidth = (word.length / text.length) * item.width;
        // TODO use transform array to calculate BBox rotation for vertical words (ex. in testReadingOrder.pdf)
        const wordBB = new BoundingBox(
          wordLeft,
          transform[5] - item.height,
          wordWidth,
          item.height,
        );
        /*
          if this condition is met, it means that the actual word was splitted in half
          and it should be part of the last word pushed to the pageElements array.
        */
        if (
          pageElements[pageElements.length - 1] &&
          pageElements[pageElements.length - 1].content.toString().trim().length > 0 &&
          pageElements[pageElements.length - 1].left +
            pageElements[pageElements.length - 1].width +
            1 >
            wordBB.left &&
          pageElements[pageElements.length - 1].left +
            pageElements[pageElements.length - 1].width -
            1 <
            wordBB.left
        ) {
          pageElements[pageElements.length - 1].width += wordBB.width;
          pageElements[pageElements.length - 1].content = pageElements[
            pageElements.length - 1
          ].content.concat(word);
        } else {
          pageElements.push(new Word(wordBB, word, font));
        }

        /*
          the X coordinate of the next word in item is calculated using the width of the actual word
          and an average char width for the 'item.str' as a blank space
        */
        wordLeft += wordWidth + avgCharWidth;
      });
    }
  });

  return new Page(pageNum, pageElements, new BoundingBox(0, 0, viewport.width, viewport.height));
}
