/**
 * stackRenderer.js
 * ------------------------------------------------------------
 * スプライトスタッキング描画エンジン本体。
 *
 * 「輪切りにした2D画像を下から順に少しずつ上へずらして回転描画する」
 * さらに木や草では「高い層ほど横へ少しずらす」だけで自然な風の揺れを表現します。
 */
(function (global) {
  "use strict";

  /**
   * ワールド座標 (wx, wy) を、カメラ中心とカメラ回転角を使ってスクリーン座標へ変換する。
   */
  function projectWorldToScreen(wx, wy, cam) {
    const dx = wx - cam.x;
    const dy = wy - cam.y;
    const cos = Math.cos(cam.angle);
    const sin = Math.sin(cam.angle);

    return {
      x: cam.screenCenterX + (dx * cos - dy * sin),
      y: cam.screenCenterY + (dx * sin + dy * cos),
    };
  }

  /**
   * スクリーン座標 (sx, sy) をワールド座標へ逆変換する（マウス照準に使用）。
   */
  function screenToWorld(sx, sy, cam) {
    const dx = sx - cam.screenCenterX;
    const dy = sy - cam.screenCenterY;
    const cos = Math.cos(-cam.angle);
    const sin = Math.sin(-cam.angle);

    return {
      x: cam.x + (dx * cos - dy * sin),
      y: cam.y + (dx * sin + dy * cos),
    };
  }

  /**
   * スプライトスタッキングの核心描画関数。
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} model         models.js で生成したモデル
   * @param {object} params
   *   - x, y           : スクリーン上の底面中心座標
   *   - angle          : 回転角（ラジアン）
   *   - scale          : 描画倍率（省略時は model.scale）
   *   - sliceSpacing   : 1層あたりのY方向オフセット量（px）
   *   - maxLayerRatio  : 0〜1。何割の層まで描画するか（学習用の積み上げ確認）
   *   - useShading     : 下を暗く・上を明るくする高さ陰影を使うか
   *   - showShadow     : 地面の楕円影を描くか
   *   - pixelated      : imageSmoothingEnabled を false にしてドットをくっきり描くか
   *   - showWireframe  : 各層の回転バウンディング枠とZ軸（しなり曲線）を描くか
   *   - flash          : 被弾時の白フラッシュ
   *   - highlightLayer : 特定の層 index を強調表示（プレビューのホバー用）
   *   - elevation      : 地面からの浮き高さ（px、自機や弾丸）
   *   - swayX, swayY   : 頂上レイヤーでの風揺れ最大オフセット（px）
   *   - swayTwist      : 頂上レイヤーでのわずかな回転ねじれ（ラジアン）
   *   - swayCurve      : しなりカーブの指数（大きいほど根元が固く、先端だけ揺れる）
   */
  function drawStackedSprite(ctx, model, params) {
    const scale = params.scale !== undefined ? params.scale : model.scale;
    const drawW = model.width * scale;
    const drawH = model.height * scale;
    const spacing = params.sliceSpacing !== undefined ? params.sliceSpacing : 2.0;
    const elevation = params.elevation || 0;

    const swayX = params.swayX || 0;
    const swayY = params.swayY || 0;
    const swayTwist = params.swayTwist || 0;
    const swayCurve = params.swayCurve !== undefined ? params.swayCurve : model.swayCurve || 1.7;

    // 描画する層数（最低1層）
    const ratio = params.maxLayerRatio !== undefined ? params.maxLayerRatio : 1;
    const visibleLayers = Math.max(1, Math.min(model.layerCount, Math.ceil(model.layerCount * ratio)));

    // 1. 接地影（地面の高さ y に描く。揺れに合わせて影もごくわずかに動く）
    if (params.showShadow) {
      ctx.save();
      ctx.translate(params.x + swayX * 0.18, params.y + 4 + swayY * 0.12);
      ctx.fillStyle = "rgba(10, 22, 12, 0.30)";
      ctx.beginPath();
      ctx.ellipse(0, 0, drawW * 0.44, drawH * 0.28, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 2. Z軸のガイド線（デバッグ表示ONのとき：木や草がしなる曲線がそのまま見える！）
    if (params.showWireframe) {
      ctx.save();
      ctx.strokeStyle = "rgba(56, 189, 248, 0.72)";
      ctx.lineWidth = 1.4;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      for (let z = 0; z < visibleLayers; z++) {
        const t = model.layerCount > 1 ? z / (model.layerCount - 1) : 0;
        const bend = Math.pow(t, swayCurve);
        const px = params.x + swayX * bend;
        const py = params.y - elevation - z * spacing + swayY * bend;
        if (z === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.restore();
    }

    // 使用するスライス配列を選択
    const canvases = params.flash
      ? model.flashCanvases
      : params.useShading
      ? model.shadedCanvases
      : model.rawCanvases;

    // ドット絵のにじみ防止設定
    ctx.imageSmoothingEnabled = !params.pixelated;

    // 3. 【ここがスプライトスタッキング本体】
    //    底面 (z = 0) から頂上 (z = visibleLayers - 1) まで1枚ずつ上にずらして重ねる
    for (let z = 0; z < visibleLayers; z++) {
      // 高さの割合 (0 = 根元, 1 = 頂上) に応じてしなり量を計算
      const t = model.layerCount > 1 ? z / (model.layerCount - 1) : 0;
      const bend = Math.pow(t, swayCurve);

      const layerX = params.x + swayX * bend;
      const layerY = params.y - elevation - z * spacing + swayY * bend;
      const layerAngle = params.angle + swayTwist * bend;

      ctx.save();
      ctx.translate(layerX, layerY);
      ctx.rotate(layerAngle);

      // ホバー強調モード: 対象層以外は少し半透明にする
      const hasHighlight = params.highlightLayer !== null && params.highlightLayer !== undefined;
      if (hasHighlight && z !== params.highlightLayer) {
        ctx.globalAlpha = 0.25;
      }

      ctx.drawImage(canvases[z], -drawW / 2, -drawH / 2, drawW, drawH);

      // デバッグ枠、またはホバー中の層の強調枠
      if (params.showWireframe || (hasHighlight && z === params.highlightLayer)) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle =
          hasHighlight && z === params.highlightLayer
            ? "#fbbf24"
            : "rgba(226, 232, 240, 0.28)";
        ctx.lineWidth = hasHighlight && z === params.highlightLayer ? 1.8 : 1;
        ctx.strokeRect(-drawW / 2, -drawH / 2, drawW, drawH);
      }

      ctx.restore();
    }
  }

  global.StackDemo = global.StackDemo || {};
  global.StackDemo.projectWorldToScreen = projectWorldToScreen;
  global.StackDemo.screenToWorld = screenToWorld;
  global.StackDemo.drawStackedSprite = drawStackedSprite;
})(window);
