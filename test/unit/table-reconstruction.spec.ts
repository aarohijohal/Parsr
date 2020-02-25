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

import { expect } from 'chai';
import * as fs from 'fs';
import { withData } from 'leche';
import 'mocha';
import { TableDetectionModule } from '../../server/src/processing/TableDetectionModule/TableDetectionModule';
import { Document, Table } from '../../server/src/types/DocumentRepresentation';
import { json2document } from '../../server/src/utils/json2document';

import { runModules, TableExtractorStub } from './../helpers';

const assetsDir = __dirname + '/assets/table-reconstruction/';

describe('Table Reconstruction Module', () => {
  describe('horizontal cell merge', () => {
    withData(
      {
        'table with no joined cells': [
          'very-simple-output.json', [
            [1, 1, 1, 1, 1, 1],
            [1, 1, 1, 1, 1, 1],
            [1, 1, 1, 1, 1, 1]],
        ],
        'only one cell merge': [
          'one-cell-merged.json', [
            [2, 1, 1, 1, 1],
            [1, 1, 1, 1, 1, 1],
            [1, 1, 1, 1, 1, 1],
          ],
        ],
        'two different merges in same row': [
          'two-different-merges-in-same-row.json', [
            [2, 1, 1, 2],
            [1, 2, 2, 1],
            [1, 1, 1, 1, 1, 1],
          ],
        ],
        'two different consecutive merges in same row': [
          'two-different-consecutive-merges-in-same-row.json', [
            [2, 2, 1, 1],
            [1, 1, 1, 1, 1, 1],
            [1, 2, 2, 1],
          ],
        ],
        'multiple colspan merge in multiple rows': [
          'multiple-colspan-merge.json', [
            [4, 1, 1],
            [1, 3, 2],
            [6],
          ],
        ],
      },
      (fileName, cellInfo) => {
        let docBefore: Document;
        let table: Table;

        before(done => {
          const json = JSON.parse(
            fs.readFileSync(assetsDir + 'test-table-reconstruction.json', { encoding: 'utf8' }),
          );
          const camelotOutput = fs.readFileSync(assetsDir + fileName, { encoding: 'utf8' });

          docBefore = json2document(json);
          docBefore.inputFile = assetsDir + 'test-table-reconstruction.pdf';
          const tableExtractor = new TableExtractorStub(0, '', camelotOutput);
          const tableDetectionModule = new TableDetectionModule();
          tableDetectionModule.setExtractor(tableExtractor);
          runModules(docBefore, [tableDetectionModule]).then(after => {
            table = after.getElementsOfType<Table>(Table)[0];
            done();
          });
        });

        it(`should have correctly merged cells`, () => {
          cellInfo.forEach((row, rowIndex) => {
            row.forEach((colspan, colIndex) => {
              expect(table.content[rowIndex].content[colIndex].colspan).to.equal(colspan);
            });
          });
        });

        it(`row should have correct amount of cells`, () => {
          cellInfo.forEach((row, rowIndex) => {
            expect(table.content[rowIndex].content.length).to.equal(row.length);
          });
        });
      },
    );
  });
});
