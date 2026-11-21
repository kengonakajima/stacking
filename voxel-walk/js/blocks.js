/**
 * blocks.js
 * ------------------------------------------------------------
 * ボクセルブロック（土 / 草 / 木の幹 / 葉 / 水）とプレイヤーキャラクターの
 * 2Dスライス（輪切りテクスチャ）、および水のアニメーションテクスチャを生成します。
 *
 * 1ブロック = 8x8 ピクセル（水平） × 8 スライス（高さ）の立方体。
 * 水の8段階の深さ (1..8) がそのまま 1..8 スライスに 1対1 で対応します。
 */
(function (global) {
  "use strict";

  const BLOCK_SIZE = 8; // 1ブロックの水平ピクセル幅 (8x8)
  const BLOCK_SLICES = 8; // 1ブロックの高さスライス枚数 (0..7) = 水の8段階と一致

  const BLOCK_AIR = 0;
  const BLOCK_DIRT = 1;
  const BLOCK_GRASS = 2;
  const BLOCK_WOOD = 3;
  const BLOCK_LEAVES = 4;

  const BLOCK_NAMES = {
    [BLOCK_AIR]: "空中",
    [BLOCK_DIRT]: "土ブロック",
    [BLOCK_GRASS]: "草ブロック",
    [BLOCK_WOOD]: "木の幹",
    [BLOCK_LEAVES]: "葉ブロック",
  };

  // 高速な整数ハッシュ（64x64 ワールド生成・ベイクを高速化）
  function hash3(x, y, z) {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1274126177)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) * 2.3283064365386963e-10;
  }

  /**
   * 明暗係数 factor を適用する。暗くなるほどわずかに寒色（青み）へ寄せることで、
   * 影が濁らず空の環境光を受けた立体的な陰影になる。
   */
  function shadeColor(r, g, b, factor) {
    const shadow = Math.max(0, 1 - factor);
    const rMult = factor * (1 - shadow * 0.14);
    const gMult = factor * (1 - shadow * 0.03);
    const bMult = factor * (1 + shadow * 0.18);
    return [
      Math.min(255, Math.max(0, Math.round(r * rMult))),
      Math.min(255, Math.max(0, Math.round(g * gMult))),
      Math.min(255, Math.max(0, Math.round(b * bMult))),
    ];
  }

  /**
   * ブロック内のローカル座標 (lx, ly, lz) の基本色 [r, g, b] を返す。
   * isTopFace が true のときはブロック上面（天面キャップ）として明るく描画する。
   */
  function sampleBlockColor(blockType, lx, ly, lz, variantSeed, isTopFace) {
    const topFace = isTopFace !== undefined ? isTopFace : lz === BLOCK_SLICES - 1;
    const n = hash3(lx + variantSeed * 13, ly + variantSeed * 7, lz + variantSeed * 5);
    const isEdge = lx === 0 || lx === BLOCK_SIZE - 1 || ly === 0 || ly === BLOCK_SIZE - 1;
    const isNearEdge = lx <= 1 || lx >= BLOCK_SIZE - 2 || ly <= 1 || ly >= BLOCK_SIZE - 2;

    // 面の向きによる明暗差（上面を明るく、垂直の側面をしっかり暗くする）
    let faceLight = 1.0;
    if (topFace) {
      faceLight = 1.06;
    } else {
      let sideLight = 0.62;
      if (isNearEdge) {
        const dWest = lx;
        const dEast = BLOCK_SIZE - 1 - lx;
        const dNorth = ly;
        const dSouth = BLOCK_SIZE - 1 - ly;
        const minD = Math.min(dWest, dEast, dNorth, dSouth);

        let dirLight = 1.0;
        if (dWest === minD) dirLight = Math.min(dirLight, 0.50); // 西面
        if (dNorth === minD) dirLight = Math.min(dirLight, 0.58); // 北面
        if (dSouth === minD) dirLight = Math.min(dirLight, 0.68); // 南面
        if (dEast === minD) dirLight = Math.min(dirLight, 0.76); // 東面
        sideLight = dirLight;
      }
      const heightGrad = 0.80 + (Math.min(lz, BLOCK_SLICES - 1) / (BLOCK_SLICES - 1)) * 0.24;
      faceLight = sideLight * heightGrad;
    }

    // ===== 土ブロック =====
    if (blockType === BLOCK_DIRT) {
      let r, g, b;
      if (n > 0.91) {
        r = 128; g = 120; b = 112;
      } else if (n > 0.66) {
        r = 148; g = 102; b = 66;
      } else if (n > 0.30) {
        r = 128; g = 86; b = 54;
      } else {
        r = 104; g = 68; b = 42;
      }
      return shadeColor(r, g, b, faceLight);
    }

    // ===== 草ブロック =====
    if (blockType === BLOCK_GRASS) {
      if (topFace || lz >= BLOCK_SLICES - 2) {
        let r, g, b;
        if (n > 0.78) { r = 116; g = 198; b = 76; }
        else if (n > 0.40) { r = 92; g = 176; b = 62; }
        else if (n > 0.14) { r = 74; g = 152; b = 50; }
        else { r = 62; g = 134; b = 44; }
        return shadeColor(r, g, b, faceLight);
      }

      // 側面の草の垂れ下がり（ギザギザ草フリンジ）
      if (lz === BLOCK_SLICES - 3 && isNearEdge) {
        const overhang = hash3(lx * 3 + variantSeed, ly * 3 + variantSeed, 99);
        if (overhang > 0.36) {
          return shadeColor(n > 0.5 ? 82 : 64, n > 0.5 ? 162 : 138, n > 0.5 ? 54 : 45, faceLight);
        }
      }
      if (lz === BLOCK_SLICES - 4 && isEdge) {
        const drip = hash3(lx * 5 + variantSeed, ly * 5 + variantSeed, 77);
        if (drip > 0.74) {
          return shadeColor(66, 140, 46, faceLight);
        }
      }

      let r, g, b;
      if (n > 0.91) { r = 128; g = 120; b = 112; }
      else if (n > 0.66) { r = 148; g = 102; b = 66; }
      else if (n > 0.30) { r = 128; g = 86; b = 54; }
      else { r = 104; g = 68; b = 42; }
      return shadeColor(r, g, b, faceLight);
    }

    // ===== 木の幹（原木） =====
    if (blockType === BLOCK_WOOD) {
      if (topFace) {
        // 年輪パターン
        const cx = Math.abs(lx - 3.5);
        const cy = Math.abs(ly - 3.5);
        const ring = Math.max(cx, cy);
        if (ring >= 3.2) return shadeColor(98, 66, 40, faceLight); // 外皮
        if (ring >= 2.0) return shadeColor(192, 152, 102, faceLight);
        if (ring >= 1.0) return shadeColor(166, 126, 78, faceLight);
        return shadeColor(142, 102, 60, faceLight);
      }
      // 側面の縦の樹皮スジ
      const barkStripe = hash3(lx + variantSeed * 3, ly + variantSeed * 5, 11);
      let r, g, b;
      if (barkStripe > 0.66) { r = 122; g = 84; b = 52; }
      else if (barkStripe > 0.30) { r = 98; g = 66; b = 40; }
      else { r = 74; g = 48; b = 28; }
      return shadeColor(r, g, b, faceLight);
    }

    // ===== 葉ブロック =====
    if (blockType === BLOCK_LEAVES) {
      let r, g, b;
      if (n > 0.80) { r = 98; g = 178; b = 66; }
      else if (n > 0.48) { r = 68; g = 146; b = 52; }
      else if (n > 0.18) { r = 46; g = 116; b = 42; }
      else { r = 32; g = 86; b = 34; }
      return shadeColor(r, g, b, faceLight);
    }

    return [255, 0, 255];
  }

  /**
   * 64x64 ワールドの水面アニメーション用タイルテクスチャ（16フレーム, 256x256）を事前生成。
   * 水面特有の網目模様（コースティクス）を作る「周期 Worley / Voronoi セルラーノイズ」を使用。
   * - セル内部は透明度が高く水底がくっきり透ける
   * - セル境界 (F2 - F1 ≈ 0) に細いアクア色の光の網目が浮かび、
   *   特徴点が円軌道を描くことで空間(32px)も時間(16フレーム)も完全にシームレスに揺らぐ
   */
  function buildWaterAnimFrames(worldBlocksX, worldBlocksY) {
    const pxPerBlock = 4; // 64 * 4 = 256px
    const w = worldBlocksX * pxPerBlock;
    const h = worldBlocksY * pxPerBlock;
    const tileSize = 32; // 8x8ブロック周期の大きなシームレスタイル
    const halfTile = tileSize * 0.5;
    const frameCount = 16;
    const frames = [];

    // 4x4 の層化ジッターグリッドで16個の特徴点を配置（ムラのない美しいセル構造）
    const gridN = 4;
    const cellSpan = tileSize / gridN; // 8px
    const basePoints = [];
    for (let gy = 0; gy < gridN; gy++) {
      for (let gx = 0; gx < gridN; gx++) {
        const id = gy * gridN + gx;
        const jx = (hash3(gx, gy, 401) - 0.5) * cellSpan * 0.65;
        const jy = (hash3(gx, gy, 709) - 0.5) * cellSpan * 0.65;
        basePoints.push({
          bx: (gx + 0.5) * cellSpan + jx,
          by: (gy + 0.5) * cellSpan + jy,
          orbitR: 1.1 + hash3(gx, gy, 911) * 0.7,
          phase0: hash3(gx, gy, 1301) * Math.PI * 2,
          dir: id % 2 === 0 ? 1 : -1,
        });
      }
    }

    const TWO_PI = Math.PI * 2;
    const curX = new Float32Array(basePoints.length);
    const curY = new Float32Array(basePoints.length);

    for (let f = 0; f < frameCount; f++) {
      const phase = (f / frameCount) * TWO_PI;

      // 各特徴点を閉じた円軌道上で動かす（16フレームで完全に元の位置に戻る）
      for (let p = 0; p < basePoints.length; p++) {
        const bp = basePoints[p];
        const a = bp.phase0 + phase * bp.dir;
        let px = bp.bx + Math.cos(a) * bp.orbitR;
        let py = bp.by + Math.sin(a) * bp.orbitR;
        px = ((px % tileSize) + tileSize) % tileSize;
        py = ((py % tileSize) + tileSize) % tileSize;
        curX[p] = px;
        curY[p] = py;
      }

      const tile = document.createElement("canvas");
      tile.width = tileSize;
      tile.height = tileSize;
      const tCtx = tile.getContext("2d");
      const tImg = tCtx.createImageData(tileSize, tileSize);

      for (let y = 0; y < tileSize; y++) {
        for (let x = 0; x < tileSize; x++) {
          // トーラス周期距離で最近傍 d1 と 2番目 d2 を求める（Worley / Voronoi）
          let d1 = 9999;
          let d2 = 9999;
          for (let p = 0; p < basePoints.length; p++) {
            let dx = Math.abs(x - curX[p]);
            if (dx > halfTile) dx = tileSize - dx;
            let dy = Math.abs(y - curY[p]);
            if (dy > halfTile) dy = tileSize - dy;
            const dist = Math.hypot(dx, dy);
            if (dist < d1) {
              d2 = d1;
              d1 = dist;
            } else if (dist < d2) {
              d2 = dist;
            }
          }

          // F2 - F1 が 0 に近いほど「水面の光の網目（コースティクス稜線）」
          const ridge = d2 - d1;
          // 鋭い網目ライン (0..1)
          const web = Math.max(0, 1 - ridge / 1.65);
          const webSharp = web * web;
          // セル中心は暗く透明、縁に近づくほどわずかに明るい水色
          const cellEdge = Math.min(1, d1 / 5.5);

          // ベースは澄んだ透明水色（低アルファで底が見える）＋控えめで上品なアクア網目
          let r = 22 + cellEdge * 20 + webSharp * 72;
          let g = 130 + cellEdge * 26 + webSharp * 62;
          let b = 198 + cellEdge * 18 + webSharp * 32;
          let a = 48 + cellEdge * 22 + webSharp * 68;

          const idx = (y * tileSize + x) * 4;
          tImg.data[idx] = Math.min(255, Math.round(r));
          tImg.data[idx + 1] = Math.min(255, Math.round(g));
          tImg.data[idx + 2] = Math.min(255, Math.round(b));
          tImg.data[idx + 3] = Math.min(255, Math.round(a));
        }
      }
      tCtx.putImageData(tImg, 0, 0);

      const full = document.createElement("canvas");
      full.width = w;
      full.height = h;
      const fCtx = full.getContext("2d");
      fCtx.imageSmoothingEnabled = false;
      const pat = fCtx.createPattern(tile, "repeat");
      fCtx.fillStyle = pat;
      fCtx.fillRect(0, 0, w, h);
      frames.push(full);
    }

    return frames;
  }

  /**
   * プレビュー用の単体ブロックモデル（8枚のCanvas配列）を生成
   */
  function buildPreviewBlockModel(blockType, id, name) {
    const canvases = [];
    for (let lz = 0; lz < BLOCK_SLICES; lz++) {
      const c = document.createElement("canvas");
      c.width = BLOCK_SIZE;
      c.height = BLOCK_SIZE;
      const ctx = c.getContext("2d");
      const img = ctx.createImageData(BLOCK_SIZE, BLOCK_SIZE);
      const isTop = lz === BLOCK_SLICES - 1;

      for (let ly = 0; ly < BLOCK_SIZE; ly++) {
        for (let lx = 0; lx < BLOCK_SIZE; lx++) {
          const [r, g, b] = sampleBlockColor(blockType, lx, ly, lz, 3, isTop);
          const idx = (ly * BLOCK_SIZE + lx) * 4;
          img.data[idx] = r;
          img.data[idx + 1] = g;
          img.data[idx + 2] = b;
          img.data[idx + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      canvases.push(c);
    }

    return {
      id,
      name,
      width: BLOCK_SIZE,
      height: BLOCK_SIZE,
      layerCount: BLOCK_SLICES,
      canvases,
    };
  }

  /**
   * プレビュー用の水ブロック（8段階の半透明スライス）
   */
  function buildPreviewWaterModel() {
    const canvases = [];
    for (let lz = 0; lz < BLOCK_SLICES; lz++) {
      const c = document.createElement("canvas");
      c.width = BLOCK_SIZE;
      c.height = BLOCK_SIZE;
      const ctx = c.getContext("2d");
      const img = ctx.createImageData(BLOCK_SIZE, BLOCK_SIZE);
      const isTop = lz === BLOCK_SLICES - 1;

      for (let ly = 0; ly < BLOCK_SIZE; ly++) {
        for (let lx = 0; lx < BLOCK_SIZE; lx++) {
          const idx = (ly * BLOCK_SIZE + lx) * 4;
          if (isTop) {
            const crest = (lx + ly) % 4 === 0;
            img.data[idx] = crest ? 158 : 78;
            img.data[idx + 1] = crest ? 232 : 190;
            img.data[idx + 2] = 252;
            img.data[idx + 3] = crest ? 176 : 122;
          } else {
            img.data[idx] = 10;
            img.data[idx + 1] = 92;
            img.data[idx + 2] = 174;
            img.data[idx + 3] = 24;
          }
        }
      }
      ctx.putImageData(img, 0, 0);
      canvases.push(c);
    }

    return {
      id: "water",
      name: "水ブロック (8段階)",
      width: BLOCK_SIZE,
      height: BLOCK_SIZE,
      layerCount: BLOCK_SLICES,
      canvases,
    };
  }

  // ============================================================
  // プレイヤーキャラクター (8x8 ピクセル × 12 スライス = 1.5ブロック高)
  // ============================================================
  const PLAYER_PALETTE = {
    ".": null,
    "b": "#3b2f2f", // ブーツ
    "p": "#2d4c8a", // ズボン（青）
    "P": "#223a6b", // ズボン影
    "s": "#22b8cf", // シャツ（シアン）
    "S": "#1592a6", // シャツ影
    "k": "#f3c69f", // 肌
    "h": "#4a2c18", // 髪（茶）
    "e": "#111827", // 目
  };

  function makePlayerSliceDefs(stepPose) {
    const bootRows =
      stepPose === 0
        ? [
            "........",
            "..bb....",
            "..bb....",
            "........",
            "........",
            "..bb....",
            "..bb....",
            "........",
          ]
        : stepPose === 1
        ? [
            "........",
            "...bb...",
            "...bb...",
            "........",
            "........",
            ".bb.....",
            ".bb.....",
            "........",
          ]
        : [
            "........",
            ".bb.....",
            ".bb.....",
            "........",
            "........",
            "...bb...",
            "...bb...",
            "........",
          ];

    const legRows =
      stepPose === 0
        ? [
            "........",
            "..pp....",
            "..pp....",
            "........",
            "........",
            "..pp....",
            "..pp....",
            "........",
          ]
        : stepPose === 1
        ? [
            "........",
            "...pp...",
            "...pp...",
            "........",
            "........",
            ".pp.....",
            ".pp.....",
            "........",
          ]
        : [
            "........",
            ".pp.....",
            ".pp.....",
            "........",
            "........",
            "...pp...",
            "...pp...",
            "........",
          ];

    const hipRows = [
      "........",
      "..PP....",
      "..pp....",
      "..pp....",
      "..pp....",
      "..pp....",
      "..PP....",
      "........",
    ];

    const handLowRows =
      stepPose === 0
        ? [
            "..kk....",
            "..ss....",
            "..ss....",
            "..ss....",
            "..ss....",
            "..ss....",
            "..ss....",
            "..kk....",
          ]
        : stepPose === 1
        ? [
            ".kk.....",
            "..ss....",
            "..ss....",
            "..ss....",
            "..ss....",
            "..ss....",
            "..ss....",
            "...kk...",
          ]
        : [
            "...kk...",
            "..ss....",
            "..ss....",
            "..ss....",
            "..ss....",
            "..ss....",
            "..ss....",
            ".kk.....",
          ];

    const torsoRows = [
      "..SS....",
      "..ss....",
      "..ss....",
      "..ss....",
      "..ss....",
      "..ss....",
      "..ss....",
      "..SS....",
    ];

    const chinRows = [
      "........",
      ".hhkk...",
      ".hkkk...",
      ".hkkk...",
      ".hkkk...",
      ".hkkk...",
      ".hhkk...",
      "........",
    ];

    // 目は y=2 と y=5 に配置し、間に2pxの肌 (y=3, y=4) を挟んでしっかり離す
    const eyeRows = [
      "........",
      ".hhkk...",
      ".hhke...",
      ".hhkk...",
      ".hhkk...",
      ".hhke...",
      ".hhkk...",
      "........",
    ];

    const browRows = [
      "........",
      ".hhhk...",
      ".hhkk...",
      ".hhkk...",
      ".hhkk...",
      ".hhkk...",
      ".hhhk...",
      "........",
    ];

    const hairRows = [
      "........",
      ".hhhh...",
      ".hhhh...",
      ".hhhh...",
      ".hhhh...",
      ".hhhh...",
      ".hhhh...",
      "........",
    ];

    // 12スライス = 1.5ブロック高 (BLOCK_SLICES = 8)
    return [
      bootRows, // z=0
      legRows, // z=1
      legRows, // z=2
      hipRows, // z=3
      handLowRows, // z=4
      handLowRows, // z=5
      torsoRows, // z=6
      torsoRows, // z=7
      chinRows, // z=8
      eyeRows, // z=9
      browRows, // z=10
      hairRows, // z=11
    ];
  }

  function buildPlayerPose(stepPose) {
    const sliceDefs = makePlayerSliceDefs(stepPose);
    const size = 8;
    const canvases = [];

    for (let z = 0; z < sliceDefs.length; z++) {
      const c = document.createElement("canvas");
      c.width = size;
      c.height = size;
      const ctx = c.getContext("2d");
      const rows = sliceDefs[z];
      const shade = 0.82 + (z / (sliceDefs.length - 1)) * 0.22;

      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const hex = PLAYER_PALETTE[rows[y][x]];
          if (!hex) continue;
          const num = parseInt(hex.slice(1), 16);
          const [r, g, b] = shadeColor((num >> 16) & 255, (num >> 8) & 255, num & 255, shade);
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.fillRect(x, y, 1, 1);
        }
      }
      canvases.push(c);
    }

    return canvases;
  }

  const playerPoses = {
    idle: buildPlayerPose(0),
    stepA: buildPlayerPose(1),
    stepB: buildPlayerPose(-1),
  };

  const previewModels = {
    grass: buildPreviewBlockModel(BLOCK_GRASS, "grass", "草ブロック"),
    dirt: buildPreviewBlockModel(BLOCK_DIRT, "dirt", "土ブロック"),
    wood: buildPreviewBlockModel(BLOCK_WOOD, "wood", "木の幹"),
    leaves: buildPreviewBlockModel(BLOCK_LEAVES, "leaves", "葉ブロック"),
    water: buildPreviewWaterModel(),
    player: {
      id: "player",
      name: "プレイヤー",
      width: 8,
      height: 8,
      layerCount: playerPoses.idle.length,
      canvases: playerPoses.idle,
    },
  };

  global.VoxelWalk = global.VoxelWalk || {};
  global.VoxelWalk.BLOCK_SIZE = BLOCK_SIZE;
  global.VoxelWalk.BLOCK_SLICES = BLOCK_SLICES;
  global.VoxelWalk.BLOCK_AIR = BLOCK_AIR;
  global.VoxelWalk.BLOCK_DIRT = BLOCK_DIRT;
  global.VoxelWalk.BLOCK_GRASS = BLOCK_GRASS;
  global.VoxelWalk.BLOCK_WOOD = BLOCK_WOOD;
  global.VoxelWalk.BLOCK_LEAVES = BLOCK_LEAVES;
  global.VoxelWalk.BLOCK_NAMES = BLOCK_NAMES;
  global.VoxelWalk.hash3 = hash3;
  global.VoxelWalk.sampleBlockColor = sampleBlockColor;
  global.VoxelWalk.shadeColor = shadeColor;
  global.VoxelWalk.buildWaterAnimFrames = buildWaterAnimFrames;
  global.VoxelWalk.PLAYER_POSES = playerPoses;
  global.VoxelWalk.PREVIEW_MODELS = previewModels;
})(window);
