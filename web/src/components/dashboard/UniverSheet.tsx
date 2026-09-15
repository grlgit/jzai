'use client';

import { useEffect, useRef } from 'react';
import { Univer, LocaleType, UniverInstanceType, merge } from '@univerjs/core';
import { UniverSheetsPlugin } from '@univerjs/sheets';
import { UniverSheetsUIPlugin } from '@univerjs/sheets-ui';
import { UniverSheetsFormulaPlugin } from '@univerjs/sheets-formula';
import { UniverUIPlugin } from '@univerjs/ui';
import { UniverRenderEnginePlugin } from '@univerjs/engine-render';
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula';
import { UniverSheetsNumfmtPlugin } from '@univerjs/sheets-numfmt';
import { UniverDocsPlugin } from '@univerjs/docs';
import { UniverDocsUIPlugin } from '@univerjs/docs-ui';

// Locale data
import SheetsZhCN from '@univerjs/sheets/locale/zh-CN';
import SheetsUIZhCN from '@univerjs/sheets-ui/locale/zh-CN';
import SheetsFormulaZhCN from '@univerjs/sheets-formula/locale/zh-CN';
import UIZhCN from '@univerjs/ui/locale/zh-CN';
import DesignZhCN from '@univerjs/design/locale/zh-CN';
import DocsUIZhCN from '@univerjs/docs-ui/locale/zh-CN';

// CSS
import '@univerjs/design/lib/index.css';
import '@univerjs/ui/lib/index.css';
import '@univerjs/docs-ui/lib/index.css';
import '@univerjs/sheets-ui/lib/index.css';

interface UniverSheetProps {
  data: any;
}

export default function UniverSheet({ data }: UniverSheetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const univerRef = useRef<Univer | null>(null);

  useEffect(() => {
    if (!containerRef.current || !data?.sheets?.length) return;

    // Clean up previous instance
    if (univerRef.current) {
      univerRef.current.dispose();
      univerRef.current = null;
      // Clear container
      if (containerRef.current) containerRef.current.innerHTML = '';
    }

    // Convert our format to Univer workbook data
    const sheetsData: Record<string, any> = {};
    const sheetOrder: string[] = [];

    for (let si = 0; si < data.sheets.length; si++) {
      const sheet = data.sheets[si];
      const cellData: Record<number, Record<number, any>> = {};

      for (let r = 0; r < (sheet.rows || []).length; r++) {
        const row = sheet.rows[r];
        if (!row) continue;
        cellData[r] = {};
        for (let c = 0; c < row.length; c++) {
          const cell = row[c];
          if (!cell) continue;
          const hasBg = cell.s?.bgColor;
          if (cell.v === null && !cell.f && !hasBg) continue;
          const uCell: any = {};
          if (cell.f) {
            uCell.f = cell.f;
            if (cell.v !== undefined) uCell.v = cell.v;
          } else if (cell.v !== null && cell.v !== undefined) {
            uCell.v = cell.v;
          }
          // Style — Univer v0.25 uses inline style object in `s`
          const style: any = {};
          let hasStyle = false;
          if (cell.s?.bold) { style.bl = 1; hasStyle = true; }
          if (cell.s?.color) {
            const fc = cell.s.color;
            style.cl = { rgb: fc.length === 8 ? '#' + fc.slice(2) : '#' + fc };
            hasStyle = true;
          }
          if (hasBg) {
            const argb = cell.s.bgColor;
            style.bg = { rgb: argb.length === 8 ? '#' + argb.slice(2) : '#' + argb };
            hasStyle = true;
          }
          if (hasStyle) uCell.s = style;
          cellData[r][c] = uCell;
        }
      }

      const sheetId = `sheet_${si}`;
      sheetOrder.push(sheetId);
      sheetsData[sheetId] = {
        id: sheetId,
        name: sheet.name || `Sheet${si + 1}`,
        cellData,
        rowCount: Math.max(sheet.rowCount || 0, Object.keys(cellData).length + 20, 50),
        columnCount: Math.max(sheet.colCount || 0, 26),
        defaultRowHeight: 24,
        defaultColumnWidth: 100,
      };
    }

    const workbookData = {
      id: 'workbook-1',
      name: data.filename || 'Workbook',
      sheetOrder,
      sheets: sheetsData,
      locale: LocaleType.ZH_CN,
    };

    // Merge all locale data
    const locales = {
      [LocaleType.ZH_CN]: merge(
        {},
        SheetsZhCN,
        SheetsUIZhCN,
        SheetsFormulaZhCN,
        UIZhCN,
        DesignZhCN,
        DocsUIZhCN,
      ),
    };

    // Create Univer instance
    const univer = new Univer({
      locale: LocaleType.ZH_CN,
      locales,
    });

    // Register plugins in correct order
    univer.registerPlugin(UniverRenderEnginePlugin);
    univer.registerPlugin(UniverFormulaEnginePlugin);
    univer.registerPlugin(UniverUIPlugin, {
      container: containerRef.current,
      ribbonType: 'simple',
    });

    // Docs plugins (required for cell editor)
    univer.registerPlugin(UniverDocsPlugin);
    univer.registerPlugin(UniverDocsUIPlugin);

    // Sheets plugins
    univer.registerPlugin(UniverSheetsPlugin);
    univer.registerPlugin(UniverSheetsUIPlugin);
    univer.registerPlugin(UniverSheetsFormulaPlugin);
    univer.registerPlugin(UniverSheetsNumfmtPlugin);

    // Create workbook
    univer.createUnit(UniverInstanceType.UNIVER_SHEET, workbookData);
    univerRef.current = univer;

    return () => {
      univer.dispose();
      univerRef.current = null;
    };
  }, [data]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
