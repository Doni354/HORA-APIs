/* eslint-disable */
/**
 * ==========================================
 * EXCEL MODULE: STYLING & TEMPLATE HELPERS
 * ==========================================
 */

const COLORS = {
  PURPLE: "FF7857FF",
  ORANGE: "FFFFA500",
  RED: "FFFF0000",
  WHITE: "FFFFFFFF",
  BLACK: "FF000000",
  LINK_BLUE: "FF0000FF",
  GRID_LIGHT: "FFD3D3D3" // Warna abu-abu yang mirip gridline default Excel
};

const ExcelFormatter = {
  /**
   * Mengatur style standar untuk cell
   */
  setCellStyle: (cell, bg = COLORS.PURPLE, fontColor = COLORS.WHITE, align = "center") => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: bg },
    };
    cell.font = {
      name: "DM Sans",
      color: { argb: fontColor },
      bold: fontColor === COLORS.WHITE,
    };
    cell.alignment = { 
      vertical: "middle", 
      horizontal: align, 
      wrapText: false // Agar baris tidak bertambah tinggi, tapi melebar ke samping
    };
    // Memberikan border tipis agar cell tidak terlihat menyatu saat di-fill warna
    cell.border = {
      top: { style: 'thin', color: { argb: COLORS.GRID_LIGHT } },
      left: { style: 'thin', color: { argb: COLORS.GRID_LIGHT } },
      bottom: { style: 'thin', color: { argb: COLORS.GRID_LIGHT } },
      right: { style: 'thin', color: { argb: COLORS.GRID_LIGHT } }
    };
  },

  /**
   * Styling untuk isi data rincian
   */
  applyDataCellStyle: (cell, value, isLink = false, linkUrl = null) => {
    const valStr = String(value || "-").trim().toLowerCase();
    let bgColor = COLORS.WHITE;
    let textColor = COLORS.BLACK;

    if (!value || value === "-" || value === "0") {
      bgColor = COLORS.RED;
      textColor = COLORS.BLACK; 
      cell.value = "-";
    } else if (["izin", "sakit", "cuti"].includes(valStr)) {
      bgColor = COLORS.ORANGE;
      textColor = COLORS.BLACK;
      cell.value = value;
    } else if (isLink && linkUrl) {
      cell.value = { text: "Buka", hyperlink: linkUrl };
      textColor = COLORS.LINK_BLUE;
    } else {
      cell.value = value;
    }

    // Data rincian di bawah tanggal: Center
    ExcelFormatter.setCellStyle(cell, bgColor, textColor, "center");
    
    if (isLink && linkUrl) {
      cell.font.underline = true;
      cell.font.name = "DM Sans";
    }
  },

  /**
   * Menyesuaikan lebar kolom secara otomatis berdasarkan konten terpanjang
   */
  adjustColumnWidth: (ws) => {
    ws.columns.forEach(column => {
      let maxColumnLength = 0;
      column.eachCell({ includeEmpty: true }, cell => {
        let value = cell.value;
        if (value && typeof value === 'object' && value.text) value = value.text; // Untuk hyperlink
        
        let columnLength = value ? value.toString().length : 10;
        if (columnLength > maxColumnLength) {
          maxColumnLength = columnLength;
        }
      });
      // Set lebar kolom: minimal 12, atau panjang konten + sedikit padding
      column.width = maxColumnLength < 12 ? 12 : maxColumnLength + 5;
    });
  },

  /**
   * Memastikan ketinggian baris seragam (±0.5 cm)
   */
  fixRowHeights: (ws) => {
    ws.eachRow((row) => {
      row.height = 15; // Ukuran standar yang rapi
    });
  },

  formatDuration: (val) => {
    if (!val || isNaN(val)) return "00:00:00";
    const totalSeconds = Math.round(parseFloat(val) * 3600);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return [hours, minutes, seconds].map(v => v < 10 ? "0" + v : v).join(":");
  },

  formatToAMPM: (timestamp) => {
    if (!timestamp) return "-";
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    if (isNaN(date.getTime())) return "-";
    return date.toLocaleTimeString("en-US", { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
  }
};

const ExcelTemplate = {
  /**
   * Build Header Informasi (A1-C7)
   */
  buildHeaderInfo: (ws, values) => {
    const labels = ["Perihal", "Dari tanggal", "Hingga Tanggal", "Pengirim", "Penerima", "Tanggal", "Jam"];
    labels.forEach((label, i) => {
      const rowNum = i + 1;
      const cellA = ws.getCell(`A${rowNum}`);
      const cellB = ws.getCell(`B${rowNum}`);
      const cellC = ws.getCell(`C${rowNum}`);

      cellA.value = label;
      cellB.value = ":";
      cellC.value = values[i] || "-";

      ExcelFormatter.setCellStyle(cellA, COLORS.PURPLE, COLORS.WHITE, "left");
      ExcelFormatter.setCellStyle(cellB, COLORS.PURPLE, COLORS.WHITE, "center");
      ExcelFormatter.setCellStyle(cellC, COLORS.PURPLE, COLORS.WHITE, "left");
    });
  },

  /**
   * Build Header Grid Tabel
   */
  buildTableGridHeader: (ws, startRow) => {
    const r1 = startRow;
    const r2 = startRow + 1;

    ws.mergeCells(`A${r1}:A${r2}`);
    ws.mergeCells(`B${r1}:B${r2}`);
    ws.getCell(`A${r1}`).value = "Nama";
    ws.getCell(`B${r1}`).value = "Rincian";
    
    ExcelFormatter.setCellStyle(ws.getCell(`A${r1}`), COLORS.PURPLE, COLORS.WHITE, "center");
    ExcelFormatter.setCellStyle(ws.getCell(`B${r1}`), COLORS.PURPLE, COLORS.WHITE, "center");

    ws.mergeCells(r1, 3, r1, 33);
    const dateLabel = ws.getCell(r1, 3);
    dateLabel.value = "TANGGAL";
    ExcelFormatter.setCellStyle(dateLabel, COLORS.PURPLE, COLORS.WHITE, "center");

    for (let d = 1; d <= 31; d++) {
      const col = 2 + d;
      const cell = ws.getCell(r2, col);
      cell.value = d;
      ExcelFormatter.setCellStyle(cell, COLORS.PURPLE, COLORS.WHITE, "center");
    }
  }
};

module.exports = { ExcelFormatter, ExcelTemplate, COLORS };