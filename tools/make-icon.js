'use strict';
/**
 * 应用图标生成器
 * 用 System.Drawing 直接画 1024px 母图，再导出多尺寸 .ico。
 * 不依赖任何第三方库，随时可重跑：node tools/make-icon.js
 *
 * 设计：蓝色圆角底 + 白色文件夹 + 2×2 分类方块
 *  - 16px 时只有「蓝底 + 白块」两团，仍然认得出
 *  - 方块是 2×2 网格，对应软件最核心的动作：把散的东西排进网格
 */
const path = require('path');
const fs = require('fs');
const win = require('../winutil');

const ROOT = path.join(__dirname, '..');

const CS = String.raw`
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

public static class IconMaker {
  static GraphicsPath RoundRect(RectangleF r, float rad) {
    GraphicsPath p = new GraphicsPath();
    float d = rad * 2f;
    p.AddArc(r.X, r.Y, d, d, 180, 90);
    p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
    p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
    p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
    p.CloseFigure();
    return p;
  }

  static byte[] ToPng(Bitmap b) {
    MemoryStream ms = new MemoryStream();
    b.Save(ms, ImageFormat.Png);
    return ms.ToArray();
  }

  // 32bpp 位图 -> ICO 里的 DIB 数据（BITMAPINFOHEADER + BGRA + AND 掩码）
  static byte[] ToDib(Bitmap b) {
    int w = b.Width, h = b.Height;
    BitmapData bd = b.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    byte[] px = new byte[bd.Stride * h];
    System.Runtime.InteropServices.Marshal.Copy(bd.Scan0, px, 0, px.Length);
    int stride = bd.Stride;
    b.UnlockBits(bd);

    MemoryStream ms = new MemoryStream();
    BinaryWriter bw = new BinaryWriter(ms);
    // BITMAPINFOHEADER 固定 40 字节：3×int + 2×short + 6×int
    bw.Write((int)40);
    bw.Write(w);
    bw.Write(h * 2);
    bw.Write((short)1);
    bw.Write((short)32);
    bw.Write(0); bw.Write(0); bw.Write(0); bw.Write(0); bw.Write(0); bw.Write(0);
    for (int y = h - 1; y >= 0; y--) bw.Write(px, y * stride, w * 4);
    int maskRow = ((w + 31) / 32) * 4;
    byte[] zero = new byte[maskRow];
    for (int y = 0; y < h; y++) bw.Write(zero);
    bw.Flush();
    return ms.ToArray();
  }

  static Bitmap Draw(int S) {
    float k = S / 1024f;
    Bitmap bmp = new Bitmap(S, S, PixelFormat.Format32bppArgb);
    using (Graphics g = Graphics.FromImage(bmp)) {
      g.SmoothingMode = SmoothingMode.AntiAlias;
      g.PixelOffsetMode = PixelOffsetMode.HighQuality;
      g.Clear(Color.Transparent);

      // 底板：圆角方形 + 蓝色渐变
      GraphicsPath tile = RoundRect(new RectangleF(56 * k, 56 * k, 912 * k, 912 * k), 208 * k);
      using (LinearGradientBrush bg = new LinearGradientBrush(
               new PointF(56 * k, 56 * k), new PointF(968 * k, 968 * k),
               Color.FromArgb(255, 96, 158, 255), Color.FromArgb(255, 26, 61, 186))) {
        g.FillPath(bg, tile);
      }

      // 顶部高光，让蓝色不那么平
      g.SetClip(tile);
      using (LinearGradientBrush hi = new LinearGradientBrush(
               new PointF(0, 56 * k), new PointF(0, 560 * k),
               Color.FromArgb(56, 255, 255, 255), Color.FromArgb(0, 255, 255, 255))) {
        g.FillRectangle(hi, 56 * k, 56 * k, 912 * k, 504 * k);
      }
      g.ResetClip();

      // 文件夹：标签（略深）+ 主体（白），合成一条轮廓
      GraphicsPath tab = new GraphicsPath(FillMode.Winding);
      tab.AddPath(RoundRect(new RectangleF(196 * k, 284 * k, 316 * k, 130 * k), 40 * k), false);
      tab.AddPath(RoundRect(new RectangleF(196 * k, 356 * k, 632 * k, 388 * k), 48 * k), false);
      using (SolidBrush tb = new SolidBrush(Color.FromArgb(255, 219, 231, 255))) {
        g.FillPath(tb, tab);
      }

      GraphicsPath body = RoundRect(new RectangleF(196 * k, 376 * k, 632 * k, 368 * k), 48 * k);
      using (LinearGradientBrush fg = new LinearGradientBrush(
               new PointF(0, 376 * k), new PointF(0, 744 * k),
               Color.White, Color.FromArgb(255, 228, 238, 255))) {
        g.FillPath(fg, body);
      }

      // 2×2 分类方块
      Color[] cols = new Color[] {
        Color.FromArgb(255, 51, 112, 232),
        Color.FromArgb(255, 45, 190, 143),
        Color.FromArgb(255, 233, 169, 59),
        Color.FromArgb(255, 232, 106, 160)
      };
      float sq = 122 * k, gap = 44 * k;
      float x0 = (512 - 144) * k;
      float y0 = (568 - 144) * k;
      for (int i = 0; i < 4; i++) {
        float x = x0 + (i % 2) * (sq + gap);
        float y = y0 + (i / 2) * (sq + gap);
        using (GraphicsPath p = RoundRect(new RectangleF(x, y, sq, sq), 32 * k))
        using (SolidBrush br = new SolidBrush(cols[i])) {
          g.FillPath(br, p);
        }
      }
    }
    return bmp;
  }

  // 各尺寸放大 6 倍拼一张，用来看小尺寸下糊不糊
  static void Preview(string file) {
    int[] sizes = new int[] { 16, 24, 32, 48 };
    int zoom = 6, pad = 14;
    using (Bitmap sheet = new Bitmap((16 + 24 + 32 + 48) * zoom + pad * 5, 48 * zoom + pad * 2)) {
      using (Graphics g = Graphics.FromImage(sheet)) {
        g.Clear(Color.FromArgb(255, 246, 247, 250));
        g.InterpolationMode = InterpolationMode.NearestNeighbor;
        g.PixelOffsetMode = PixelOffsetMode.Half;
        int x = pad;
        foreach (int s in sizes) {
          using (Bitmap b = Draw(s)) {
            g.DrawImage(b, new Rectangle(x, pad, s * zoom, s * zoom));
            x += s * zoom + pad;
          }
        }
      }
      sheet.Save(file, ImageFormat.Png);
    }
  }

  public static string Build(string icoOut, string png1024, string png256, string previewOut) {
    int[] sizes = new int[] { 16, 24, 32, 48, 64, 128, 256 };
    List<byte[]> blobs = new List<byte[]>();
    using (Bitmap master = Draw(1024)) {
      master.Save(png1024, ImageFormat.Png);
      using (Bitmap p256 = new Bitmap(master, 256, 256)) p256.Save(png256, ImageFormat.Png);
      foreach (int s in sizes) {
        using (Bitmap small = new Bitmap(s, s, PixelFormat.Format32bppArgb)) {
          using (Graphics sg = Graphics.FromImage(small)) {
            sg.InterpolationMode = InterpolationMode.HighQualityBicubic;
            sg.PixelOffsetMode = PixelOffsetMode.HighQuality;
            sg.SmoothingMode = SmoothingMode.HighQuality;
            sg.CompositingQuality = CompositingQuality.HighQuality;
            sg.Clear(Color.Transparent);
            sg.DrawImage(master, new Rectangle(0, 0, s, s));
          }
          // 全部用 DIB：GDI+（很多老工具和部分外壳扩展）读不了 PNG 压缩的帧
          blobs.Add(ToDib(small));
        }
      }
    }

    using (MemoryStream ms = new MemoryStream()) {
      using (BinaryWriter bw = new BinaryWriter(ms)) {
        bw.Write((short)0);
        bw.Write((short)1);
        bw.Write((short)sizes.Length);
        int offset = 6 + 16 * sizes.Length;
        for (int i = 0; i < sizes.Length; i++) {
          int s = sizes[i];
          byte dim = (byte)(s >= 256 ? 0 : s);
          bw.Write(dim);
          bw.Write(dim);
          bw.Write((byte)0);
          bw.Write((byte)0);
          bw.Write((short)1);
          bw.Write((short)32);
          bw.Write(blobs[i].Length);
          bw.Write(offset);
          offset += blobs[i].Length;
        }
        foreach (byte[] d in blobs) bw.Write(d);
      }
      File.WriteAllBytes(icoOut, ms.ToArray());
    }

    Preview(previewOut);
    return "OK " + new FileInfo(icoOut).Length + " bytes";
  }
}
`;

const SCRIPT =
  "[Console]::OutputEncoding=[Text.Encoding]::UTF8\n" +
  "$ProgressPreference='SilentlyContinue'\n" +
  "Add-Type -AssemblyName System.Drawing\n" +
  "Add-Type -TypeDefinition @'\n" + CS + "\n'@ -ReferencedAssemblies System.Drawing\n" +
  `[Console]::Out.Write([IconMaker]::Build(${q(path.join(ROOT, 'app.ico'))}, ` +
  `${q(path.join(ROOT, 'icon-1024.png'))}, ${q(path.join(ROOT, 'public', 'icon-256.png'))}, ` +
  `${q(path.join(ROOT, 'icon-preview.png'))}))\n`;

function q(p) {
  return "'" + String(p).replace(/'/g, "''") + "'";
}

if (!fs.existsSync(path.join(ROOT, 'public'))) fs.mkdirSync(path.join(ROOT, 'public'), { recursive: true });
const out = win.runPS(SCRIPT, { timeout: 120000 });
console.log(String(out).trim());
