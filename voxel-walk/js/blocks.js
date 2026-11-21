/**
 * blocks.js
 * ------------------------------------------------------------
 * ボクセルブロック（土ブロック / 草ブロック）とプレイヤーキャラクターの
 * 2Dスライス（輪切りテクスチャ）を生成します。
 *
 * 1ブロック = 10x10 ピクセル（水平） × 10 スライス（高さ）の立方体。
 * 各面の明るさ（東西南北＋上面）をわずかに変えることで、
 * 360°回転してもMinecraft風のくっきりした立体感が出ます。
 */
(function (global) {
  "use strict";

  const BLOCK_SIZE = 10; // 1ブロックの水平ピクセル幅 (10x10)
  const BLOCK_SLICES = 10; // 1ブロックの高さスライス枚数 (0..9)

  const BLOCK_AIR = 0;
  const BLOCK_DIRT = 1;
  const BLOCK_GRASS = 2;

  const BLOCK_NAMES = {
    [BLOCK_AIR]: "空中",
    [BLOCK_DIRT]: "土ブロック",
    [BLOCK_GRASS]: "草ブロック",
  };

  // 決定論的ハッシュ（ピクセルノイズ用）
  function hash3(x, y, z) {
    const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453123;
    return n - Math.floor(n);
  }

  /**
   * 明暗係数 factor を適用する。暗くなるほどわずかに寒色（青み）へ寄せることで、
   * 土や草の影が黒ずんで濁らず、空の環境光を受けた立体的な陰影になる。
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

  function rgb(r, g, b, mult) {
    return shadeColor(r, g, b, mult);
  }

  /**
   * ブロック内のローカル座標 (lx, ly, lz) の基本色 [r, g, b] を返す。
   * variantSeed はワールド内の座標ハッシュ（隣り合うブロックに自然な揺らぎを出す）。
   * isTopFace が true のときはブロック上面（天面キャップ）として明るく描画する。
   */
  function sampleBlockColor(blockType, lx, ly, lz, variantSeed, isTopFace) {
    const topFace = isTopFace !== undefined ? isTopFace : lz === BLOCK_SLICES - 1;
    const n = hash3(lx + variantSeed * 13, ly + variantSeed * 7, lz + variantSeed * 5);
    const isEdge = lx === 0 || lx === BLOCK_SIZE - 1 || ly === 0 || ly === BLOCK_SIZE - 1;
    const isNearEdge = lx <= 1 || lx >= BLOCK_SIZE - 2 || ly <= 1 || ly >= BLOCK_SIZE - 2;

    // 面の向きによる明暗差（上面を明るく、垂直の側面をしっかり暗くする）
    // 仰角を低くしても内部の明るい色が漏れないよう外周2px＋内部も側面トーンにする
    let faceLight = 1.0;
    if (topFace) {
      faceLight = 1.06; // 上面がいちばん明るい
    } else {
      let sideLight = 0.62;
      if (isNearEdge) {
        // 最も近い外周面から東西南北の明るさを決める
        const dWest = lx;
        const dEast = BLOCK_SIZE - 1 - lx;
        const dNorth = ly;
        const dSouth = BLOCK_SIZE - 1 - ly;
        const minD = Math.min(dWest, dEast, dNorth, dSouth);

        let dirLight = 1.0;
        if (dWest === minD) dirLight = Math.min(dirLight, 0.50); // 西面（最も濃い影）
        if (dNorth === minD) dirLight = Math.min(dirLight, 0.58); // 北面
        if (dSouth === minD) dirLight = Math.min(dirLight, 0.68); // 南面
        if (dEast === minD) dirLight = Math.min(dirLight, 0.76); // 東面（日当たり側）
        sideLight = dirLight;
      }
      // ブロック下端ほど暗く、上端ほど明るい垂直グラデーション
      const heightGrad = 0.80 + (Math.min(lz, BLOCK_SLICES - 1) / (BLOCK_SLICES - 1)) * 0.24;
      faceLight = sideLight * heightGrad;
    }

    // ===== 土ブロック =====
    if (blockType === BLOCK_DIRT) {
      let base;
      if (n > 0.91) {
        base = [128, 120, 112]; // 小石の粒
      } else if (n > 0.66) {
        base = [148, 102, 66]; // 明るい土
      } else if (n > 0.30) {
        base = [128, 86, 54]; // 標準の土
      } else {
        base = [104, 68, 42]; // 暗い土
      }
      return rgb(base[0], base[1], base[2], faceLight);
    }

    // ===== 草ブロック =====
    if (blockType === BLOCK_GRASS) {
      // 上面キャップ、および側面の上部2層 (lz = 8, 9) は緑の芝
      if (topFace || lz >= BLOCK_SLICES - 2) {
        let base;
        if (n > 0.78) base = [116, 198, 76];
        else if (n > 0.40) base = [92, 176, 62];
        else if (n > 0.14) base = [74, 152, 50];
        else base = [62, 134, 44];
        return rgb(base[0], base[1], base[2], faceLight);
      }

      // 側面の草の垂れ下がり（Minecraft特有のギザギザ草フリンジ）
      if (lz === BLOCK_SLICES - 3 && isNearEdge) {
        const overhang = hash3(lx * 3 + variantSeed, ly * 3 + variantSeed, 99);
        if (overhang > 0.32) {
          const base = n > 0.5 ? [82, 162, 54] : [64, 138, 45];
          return rgb(base[0], base[1], base[2], faceLight);
        }
      }
      if (lz === BLOCK_SLICES - 4 && isEdge) {
        const drip = hash3(lx * 5 + variantSeed, ly * 5 + variantSeed, 77);
        if (drip > 0.72) {
          return rgb(66, 140, 46, faceLight);
        }
      }

      // 下部 (lz = 0..6) は土ブロックと同じ土テクスチャ
      let base;
      if (n > 0.91) base = [128, 120, 112];
      else if (n > 0.66) base = [148, 102, 66];
      else if (n > 0.30) base = [128, 86, 54];
      else base = [104, 68, 42];
      return rgb(base[0], base[1], base[2], faceLight);
    }

    return [255, 0, 255];
  }

  /**
   * プレビュー用の単体ブロックモデル（10枚のCanvas配列）を生成
   */
  function buildPreviewBlockModel(blockType, id, name) {
    const canvases = [];
    for (let lz = 0; lz < BLOCK_SLICES; lz++) {
      const c = document.createElement("canvas");
      c.width = BLOCK_SIZE;
      c.height = BLOCK_SIZE;
      const ctx = c.getContext("2d");
      const img = ctx.createImageData(BLOCK_SIZE, BLOCK_SIZE);

      for (let ly = 0; ly < BLOCK_SIZE; ly++) {
        for (let lx = 0; lx < BLOCK_SIZE; lx++) {
          const [r, g, b] = sampleBlockColor(blockType, lx, ly, lz, 3);
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

  // ============================================================
  // プレイヤーキャラクター (8x8 ピクセル × 15 スライス = 1.5ブロック高)
  // 正面は右 (+X) 方向。歩行アニメーション3パターン（静止 / 右足前 / 左足前）
  // ============================================================
  const PLAYER_PALETTE = {
    ".": null,
    "b": "#3b2f2f", // ブーツ
    "p": "#2d4c8a", // ズボン（青）
    "P": "#223a6b", // ズボン影
    "s": "#22b8cf", // シャツ（シアン）
    "S": "#1592a6", // シャツ影
    "k": "#f3c69f", // 肌
    "K": "#d9a57c", // 肌影
    "h": "#4a2c18", // 髪（茶）
    "e": "#111827", // 目
    "w": "#f8fafc", // 白目
  };

  function makePlayerSliceDefs(stepPose) {
    // stepPose: 0 = 静止, 1 = 左足前・右足後ろ, -1 = 右足前・左足後ろ
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

    const shoulderRows = [
      "..ss....",
      "..ss....",
      "..ss....",
      "..ss....",
      "..ss....",
      "..ss....",
      "..ss....",
      "..ss....",
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

    return [
      bootRows, // z=0
      bootRows, // z=1
      legRows, // z=2
      legRows, // z=3
      legRows, // z=4
      hipRows, // z=5
      handLowRows, // z=6
      handLowRows, // z=7
      torsoRows, // z=8
      torsoRows, // z=9
      shoulderRows, // z=10
      chinRows, // z=11
      eyeRows, // z=12
      browRows, // z=13
      hairRows, // z=14
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
          const [r, g, b] = rgb((num >> 16) & 255, (num >> 8) & 255, num & 255, shade);
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
  global.VoxelWalk.BLOCK_NAMES = BLOCK_NAMES;
  global.VoxelWalk.sampleBlockColor = sampleBlockColor;
  global.VoxelWalk.shadeColor = shadeColor;
  global.VoxelWalk.PLAYER_POSES = playerPoses;
  global.VoxelWalk.PREVIEW_MODELS = previewModels;
})(window);
