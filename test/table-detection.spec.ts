import { expect } from 'chai';
import * as fs from 'fs';
import 'mocha';
import { TableDetectionModule } from '../server/src/processing/TableDetectionModule/TableDetectionModule';
import { TableRow } from '../server/src/types/DocumentRepresentation';
import { Element } from '../server/src/types/DocumentRepresentation/Element';
import { Table } from '../server/src/types/DocumentRepresentation/Table';
import { getPdf, runModules, TableExtractorStub } from './helpers';

const pdfName = 'table-detection.pdf';

describe('No Table detection function', () => {
  let table: Element;
  const noTableDetectedExtractor = new TableExtractorStub(0, '', '[]');
  const tableDetectionModule = new TableDetectionModule();
  tableDetectionModule.setExtractor(noTableDetectedExtractor);

  before(done => {
    getPdf(
      d => runModules(d, [tableDetectionModule]),
      pdfName,
    ).then(([_, pdfAfter]) => {
      pdfAfter.pages[0].getElementsOfType<Table>(Table).forEach(elt => {
        table = elt;
      });
      done();
    });
  });

  it('should have no table detected', () => {
    expect(table).not.exist;
  });
});

describe('One Table detection function', () => {
  let table: Table;
  let tableRows: TableRow[];
  const extractorOutput = fs.readFileSync(
    `${__dirname}/assets/mocks/table-detection-one-table.json`,
    'utf8',
  );
  const oneTableDetectedExtractor = new TableExtractorStub(0, '', extractorOutput);
  const tableDetectionModule = new TableDetectionModule();
  tableDetectionModule.setExtractor(oneTableDetectedExtractor);

  before(done => {
    getPdf(
      d => runModules(d, [tableDetectionModule]),
      pdfName,
    ).then(([_, pdfAfter]) => {
      pdfAfter.pages[0].getElementsOfType<Table>(Table).forEach(elt => {
        table = elt;
        tableRows = table.content;
      });
      done();
    });
  });

  it('should have one table detected', () => {
    expect(table).exist;
  });

  it('should have first row cell with row span', () => {
    expect(tableRows[0].content[0].rowspan).to.equal(2);
  });

  it('should have first row last cell with col span', () => {
    expect(tableRows[0].content[4].colspan).to.equal(2);
  });
});
