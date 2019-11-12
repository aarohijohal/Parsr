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

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';

import * as path from 'path';
import {
  BoundingBox,
  Character,
  Document,
  Element,
  Font,
  Image,
  Page,
  Word,
} from '../../types/DocumentRepresentation';
import { PdfminerFigure } from '../../types/PdfminerFigure';
import { PdfminerImage } from '../../types/PdfminerImage';
import { PdfminerPage } from '../../types/PdfminerPage';
import { PdfminerText } from '../../types/PdfminerText';
import * as utils from '../../utils';
import logger from '../../utils/Logger';

/**
 * Executes the pdfminer extraction function, reading an input pdf file and extracting a document representation.
 * This function involves recovering page contents like words, bounding boxes, fonts and other information that
 * the pdfminer tool's output provides. This function spawns the externally existing pdfminer tool.
 *
 * @param pdfInputFile The path including the name of the pdf file for input.
 * @param imgsPhysicalLocation The location where physical images are stored
 * @returns The promise of a valid document (in the format DocumentRepresentation).
 */
export function execute(pdfInputFile: string, imgsPhysicalLocation: string): Promise<Document> {
  return new Promise<Document>((resolveDocument, rejectDocument) => {
    return repairPdf(pdfInputFile).then((repairedPdf: string) => {
      // temporary XML output filename
      const xmlOutputFile: string = utils.getTemporaryFile('.xml');

      // find python
      const pythonLocation: string = utils.getPythonLocation();

      // find pdfminer's pdf2txt.py script
      const pdf2txtLocation: string = utils.getPdf2txtLocation();

      // If either of the tools could not be found, return an empty document and display warning
      if (pythonLocation === "" || pdf2txtLocation === "") {
        rejectDocument(`Could not find the necessary libraries..`);
      }

      logger.info(`Extracting file contents with pdfminer's pdf2txt.py tool...`);

      const pdf2txtArguments: string[] = [
        pdf2txtLocation,
        '-c',
        'utf-8',
        '-t',
        'xml',
        '-o',
        xmlOutputFile,
        repairedPdf,
      ];

      logger.debug(
        `${pythonLocation} ${pdf2txtArguments.join(' ')}`,
      );

      if (!fs.existsSync(xmlOutputFile)) {
        fs.appendFileSync(xmlOutputFile, '');
      }

      const pdf2txt = spawn(pythonLocation, pdf2txtArguments);

      pdf2txt.stderr.on('data', data => {
        logger.error('pdfminer error:', data.toString('utf8'));
      });

      pdf2txt.on('close', pdf2txtReturnCode => {
        if (pdf2txtReturnCode === 0) {
          const xml: string = fs.readFileSync(xmlOutputFile, 'utf8');
          try {
            logger.debug(`Converting pdfminer's XML output to JS object..`);
            utils.parseXmlToObject(xml, { attrkey: '_attr' }).then(async (obj: any) => {

            // get the metadataobject and images ref table
            const { pdf: { object: metadataObj } } = await getFileMetadata(repairedPdf);
            const imgRefTable: object = getImgsAndRefs(metadataObj);
            const imgsIdFilenameMap: object = getImgsIdFilenameMap(imgsPhysicalLocation);

            // treat pages
            resolveDocument(
              new Document(
                obj.pages.page.map((pageObj: PdfminerPage) => getPage(
                  pageObj,
                  imgRefTable,
                  imgsIdFilenameMap),
                ),
                repairedPdf,
              ),
            );
            });
          } catch (err) {
            rejectDocument(`parseXml failed: ${err}`);
          }
        } else {
          rejectDocument(`pdf2txt return code is ${pdf2txtReturnCode}`);
        }
      });
      // return doc;
    });
  });
}

function getPage(pageObj: PdfminerPage, imgsRefTable: object, imgsIdFilenameMap: object): Page {
  const boxValues: number[] = pageObj._attr.bbox.split(',').map(v => parseFloat(v));
  const pageBBox: BoundingBox = new BoundingBox(
    boxValues[0],
    boxValues[1],
    boxValues[2],
    boxValues[3],
  );

  let elements: Element[] = [];

  // treat paragraphs
  if (pageObj.textbox !== undefined) {
    pageObj.textbox.forEach(para => {
      para.textline.map(line => {
        elements = [...elements, ...breakLineIntoWords(line.text, ',', pageBBox.height)];
      });
    });
  }

  // treat figures
  if (pageObj.figure !== undefined) {
    pageObj.figure.forEach(fig => {
      if (fig.image !== undefined) {
        elements = [...elements, ...interpretImages(fig, imgsRefTable, imgsIdFilenameMap, pageBBox.height)];
      }
      if (fig.text !== undefined) {
        elements = [...elements, ...breakLineIntoWords(fig.text, ',', pageBBox.height)];
      }
    });
  }

  return new Page(parseFloat(pageObj._attr.id), elements, pageBBox);
}

// Pdfminer's bboxes are of the format: x0, y0, x1, y1. Our BoundingBox dims are as: left, top, width, height
function getBoundingBox(
  bbox: string,
  splitter: string = ',',
  pageHeight: number = 0,
  scalingFactor: number = 1,
): BoundingBox {
  const values: number[] = bbox.split(splitter).map(v => parseFloat(v) * scalingFactor);
  const width: number = Math.abs(values[2] - values[0]); // right - left = width
  const height: number = Math.abs(values[1] - values[3]); // top - bottom = height
  const left: number = values[0];
  const top: number = Math.abs(pageHeight - values[1]) - height; // invert x direction (pdfminer's (0,0)
  // is on the bottom left)
  return new BoundingBox(left, top, width, height);
}

function getMostCommonFont(theFonts: Font[]): Font {
  const fonts: Font[] = theFonts.reduce((a, b) => a.concat(b), []);

  const baskets: Font[][] = [];

  fonts.forEach((font: Font) => {
    let basketFound: boolean = false;
    baskets.forEach((basket: Font[]) => {
      if (basket.length > 0 && basket[0].isEqual(font)) {
        basket.push(font);
        basketFound = true;
      }
    });

    if (!basketFound) {
      baskets.push([font]);
    }
  });

  baskets.sort((a, b) => {
    return b.length - a.length;
  });

  if (baskets.length > 0 && baskets[0].length > 0) {
    return baskets[0][0];
  } else {
    return Font.undefinedFont;
  }
}

/**
 * Fetches the character a particular pdfminer's textual output represents
 * TODO: This placeholder will accommodate the solution at https://github.com/aarohijohal/pdfminer.six/issues/1 ...
 * TODO: ... For now, it returns a '?' when a (cid:) is encountered
 * @param character the character value outputted by pdfminer
 * @param font the font associated with the character  -- TODO to be taken into consideration here
 */
function getValidCharacter(character: string): string {
  return RegExp(/\(cid:/gm).test(character) ? '?' : character;
}

/**
 * Interprets images from a figure object received via pdfminer's pdf2txt.py output
 * @param fig The incoming figure object from pdfminer
 * @param pageHeight The height of the page (for scaling)
 * @param scalingFactor The factor by which the bounding boxes are to be scaled
 */
function interpretImages(
  fig: PdfminerFigure,
  imgsRefTable: any,
  idFilenameMap: object,
  pageHeight: number,
  scalingFactor: number = 1,
): Image[] {
  const figureName: string = fig._attr.name !== undefined ? fig._attr.name : "";
  let imgFilenameRef: string = "";
  let figureFilename: string = "";
  if (figureName !== "" && imgsRefTable.mode !== 0) {
    imgFilenameRef = imgsRefTable.mode === 1  ? figureName.match(/(\d+)/)[0] : imgsRefTable[figureName];
    figureFilename = idFilenameMap[imgFilenameRef];
  } else {
    logger.debug(`don't have enough information to find a physical file for image`);
  }
  return fig.image.map((_img: PdfminerImage) => {
    return new Image(
      getBoundingBox(fig._attr.bbox, ',', pageHeight, scalingFactor),
      figureFilename,
    );
  });
}

/**
 * Returns id->filename map for all images
 * @param imgsPhysicalLocation physical location where all images are stored
 * @param imgFileExtensions the extensions of the image files to be accepted
 */
function getImgsIdFilenameMap(imgsPhysicalLocation: string, imgFileExtensions: string[] = ['png', 'bmp', 'jpg']) {
  const idFilenameMap: object = {};
  const imgFiles: string[] = fs.readdirSync(imgsPhysicalLocation)
  .filter(fileName => imgFileExtensions.includes(new RegExp(/(?:\.([^.]+))?$/).exec(fileName)[1]));
  imgFiles.map(fileName => {
    const id: string = parseFloat(fileName.match(/(\d+)/)[0]).toString();
    const absFilePath: string = path.join(imgsPhysicalLocation, fileName);
    idFilenameMap[id] = absFilePath;
  });
  return idFilenameMap;
}

/**
 * Extracts image names and reference ids of each object from the dump
 * The resulting modes are:
 *  0: nothing found.
 *  1: the files are probably named by their figureName ID
 *  2: the files are probably named by their reference ID
 * @param metaDataObj the meta data object coming in from dumppdf.py
 */
function getImgsAndRefs(metaDataObj: any): any {
  let xObjects: any = {};
  const result: any = {
    mode: 0,
  };
  try {
    const allDicts = metaDataObj.filter(o => o.dict).map(p => p.dict[0]);
    const resourcesDicts = allDicts.filter(q => q.key && q.key.includes('Resources'));
    const resources = resourcesDicts.map(rd => rd.value[rd.key.indexOf('Resources')].dict[0]);
    xObjects = resources.filter(q => q.key && q.key.includes('XObject'))
    .map(d => d.value[d.key.indexOf('XObject')].dict[0]);
    result.mode = 1;
  } catch (err1) {
    logger.warn(`No resources element found in the dump. Trying to look into key values directly...`);
    try {
      const allDicts = metaDataObj.filter(o => o.dict).map(p => p.dict[0]);
      xObjects = allDicts.filter(q => q.key && q.key.includes('XObject'))
      .map(d => d.value[d.key.indexOf('XObject')].dict[0]);
      result.mode = 2;
    } catch (err2) {
      logger.warn(`No resources found in the key values either. Abandoning image extraction attempt.`);
      return result;
    }
  }
  if (xObjects) {
    xObjects.forEach(xObj => {
      xObj.key.forEach(key => {
        result[key] = xObj.value[xObj.key.indexOf(key)].ref[0].$.id;
      });
    });
  }
  return result;
}

// <value>
// <dict size="1">
//     <key>Image17</key>
//     <value>
//         <ref id="37" />
//     </value>
// </dict>
// </value>
// </dict>
// </value>

// <value>
// <literal>Page</literal>
// </value>
// </dict>

function breakLineIntoWords(
  texts: PdfminerText[],
  wordSeparator: string = ' ',
  pageHeight: number,
  scalingFactor: number = 1,
): Word[] {
  const notAllowedChars = ['\u200B']; // &#8203 Zero Width Space
  const words: Word[] = [];
  const fakeSpaces = thereAreFakeSpaces(texts);
  const chars: Character[] = texts
    .filter(char => !notAllowedChars.includes(char._) && !isFakeChar(char, fakeSpaces))
    .map(char => {
      if (char._ === undefined) {
        return undefined;
      } else {
        const font: Font = new Font(char._attr.font, parseFloat(char._attr.size), {
          weight: RegExp(/bold/gim).test(char._attr.font) ? 'bold' : 'medium',
          isItalic: RegExp(/italic/gim).test(char._attr.font) ? true : false,
          isUnderline: RegExp(/underline/gim).test(char._attr.font) ? true : false,
          color: ncolourToHex(char._attr.ncolour),
        });
        const charContent: string = getValidCharacter(char._);
        return new Character(
          getBoundingBox(char._attr.bbox, ',', pageHeight, scalingFactor),
          charContent,
          font,
        );
      }
    });
  if (chars[0] === undefined || chars[0].content === wordSeparator) {
    chars.splice(0, 1);
  }
  if (chars[chars.length - 1] === undefined || chars[chars.length - 1].content === wordSeparator) {
    chars.splice(chars.length - 1, chars.length);
  }

  if (chars.length === 0 || (chars.length === 1 && chars[0] === undefined)) {
    return words;
  }

  if (
    chars
      .filter(c => c !== undefined)
      .map(c => c.content.length)
      .filter(l => l > 1).length > 0
  ) {
    logger.debug(`pdfminer returned some characters of size > 1`);
  }

  const sepLocs: number[] = chars
    .map((c, i) => {
      if (c === undefined) {
        return i;
      } else {
        return undefined;
      }
    })
    .filter(l => l !== undefined)
    .filter(l => l !== 0)
    .filter(l => l !== chars.length);

  let charSelection: Character[] = [];
  if (sepLocs.length === 0) {
    charSelection = chars.filter(c => c !== undefined);
    words.push(
      new Word(
        BoundingBox.merge(charSelection.map(c => c.box)),
        charSelection,
        getMostCommonFont(charSelection.map(c => c.font)),
      ),
    );
  } else {
    charSelection = chars.slice(0, sepLocs[0]).filter(c => c !== undefined);
    if (charSelection.length > 0) {
      words.push(
        new Word(
          BoundingBox.merge(charSelection.map(c => c.box)),
          charSelection,
          getMostCommonFont(charSelection.map(c => c.font)),
        ),
      );
    }
    for (let i = 0; i !== sepLocs.length; ++i) {
      let from: number;
      let to: number;
      from = sepLocs[i] + 1;
      if (i !== sepLocs.length - 1) {
        to = sepLocs[i + 1];
      } else {
        to = chars.length;
      }
      charSelection = chars.slice(from, to).filter(c => c !== undefined);
      if (charSelection.length > 0) {
        words.push(
          new Word(
            BoundingBox.merge(charSelection.map(c => c.box)),
            charSelection,
            getMostCommonFont(charSelection.map(c => c.font)),
          ),
        );
      }
    }
  }
  return words;
}

function thereAreFakeSpaces(texts: PdfminerText[]): boolean {
  // Will remove all <text> </text> only if in line we found
  // <text> </text> followed by empty <text> but with attributes
  // <text font="W" bbox="W" colourspace="X" ncolour="Y" size="Z"> </text>
  const emptyWithAttr = texts
    .map((word, index) => {
      return { text: word, pos: index };
    })
    .filter(word => word.text._ === undefined && word.text._attr !== undefined)
    .map(word => word.pos);
  const emptyWithNoAttr = texts
    .map((word, index) => {
      return { text: word, pos: index };
    })
    .filter(word => word.text._ === undefined && word.text._attr === undefined)
    .map(word => word.pos);

  let fakeSpaces = false;
  emptyWithNoAttr.forEach(pos => {
    if (emptyWithAttr.includes(pos + 1)) {
      fakeSpaces = true;
    }
  });
  return fakeSpaces;
}

function isFakeChar(word: PdfminerText, fakeSpacesInLine: boolean): boolean {
  if (fakeSpacesInLine && word._ === undefined && word._attr === undefined) {
    return true;
  }

  return false;
}

function ncolourToHex(color: string) {
  const rgbToHex = (r, g, b) =>
    '#' +
    [r, g, b]
      .map(x => {
        const hex = Math.ceil(x * 255).toString(16);
        return hex.length === 1 ? '0' + hex : hex;
      })
      .join('');

  const rgbColor = color
    .replace('[', '')
    .replace(']', '')
    .split(',');

  return rgbToHex(rgbColor[0], rgbColor[1] || rgbColor[0], rgbColor[2] || rgbColor[0]);
}

/**
 * Repair a pdf using the external qpdf and mutool utilities.
 * Use qpdf to decrcrypt the pdf to avoid errors due to DRMs.
 * @param filePath The absolute filename and path of the pdf file to be repaired.
 */
function repairPdf(filePath: string) {
  const qpdfPath = utils.getCommandLocationOnSystem('qpdf');
  let qpdfOutputFile = utils.getTemporaryFile('.pdf');
  if (qpdfPath) {
    const process = spawnSync('qpdf', ['--decrypt', filePath, qpdfOutputFile]);

    if (process.status === 0) {
      logger.info(`qpdf repair successfully performed on file ${filePath}. New file at: ${qpdfOutputFile}`);
    } else {
      logger.warn(`qpdf decryption could not be performed on the file ${filePath}`);
      qpdfOutputFile = filePath;
    }
  } else {
    logger.warn(`qpdf not found on the system. Not repairing the PDF...`);
    qpdfOutputFile = filePath;
  }

  return new Promise<string>(resolve => {
    const mutoolPath = utils.getCommandLocationOnSystem('mutool');
    if (!mutoolPath) {
      logger.warn('MuPDF not installed !! Skip clean PDF.');
      resolve(qpdfOutputFile);
    } else {
      const mupdfOutputFile = utils.getTemporaryFile('.pdf');
      const pdfFixer = spawn('mutool', ['clean', qpdfOutputFile, mupdfOutputFile]);
      pdfFixer.on('close', () => {
        // Check that the file is correctly written on the file system
        fs.fsyncSync(fs.openSync(qpdfOutputFile, 'r+'));
        logger.info(
          `mupdf cleaning successfully performed on file ${qpdfOutputFile}. Resulting file: ${mupdfOutputFile}`,
        );
        resolve(mupdfOutputFile);
      });
    }
  });
}

/*
  runs the 'dumppdf.py' script and returns a JSON with all the metadata found in the file
*/
export function getFileMetadata(pdfFilePath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const xmlOutputFile: string = utils.getTemporaryFile('.xml');
    const pythonLocation: string = utils.getPythonLocation();
    const dumppdfLocation: string = utils.getDumppdfLocation();
    if (dumppdfLocation === "" || pythonLocation === "") {
      reject(`Could not find the necessary libraries..`);
    }

    logger.info(`Extracting metadata with pdfminer's dumppdf.py tool...`);

    const dumppdfArguments = [dumppdfLocation, '-a', '-o', xmlOutputFile, pdfFilePath];

    logger.debug(`${pythonLocation} ${dumppdfArguments.join(' ')}`);

    if (!fs.existsSync(xmlOutputFile)) {
      fs.appendFileSync(xmlOutputFile, '');
    }

    const dumppdf = spawn(pythonLocation, dumppdfArguments);

    dumppdf.stderr.on('data', data => {
      logger.error('dumppdf error:', data.toString('utf8'));
      reject(data.toString('utf8'));
    });

    dumppdf.on('close', async code => {
      if (code === 0) {
        const xml: string = fs.readFileSync(xmlOutputFile, 'utf8');
        try {
          logger.debug(`Converting dumppdf's XML output to JS object..`);
          utils.parseXmlToObject(xml).then((obj: any) => {
            resolve(obj);
          });
        } catch (err) {
          reject(`parseXml failed: ${err}`);
        }
      } else {
        reject(`dumppdf return code is ${code}`);
      }
    });
  });
}
