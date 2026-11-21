// ページは HTML に焼き込み済み。ここでやるのは、動画のその場再生・最近の書き込み・掲示板の書き込み数の表示だけ。
// 画像はすべてこのサイトのサーバーに置いたコピーなので、読み込めないときの差し替えはしない。
(function () {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // 動画はクリックしたときだけ iframe にする（最初から埋め込むと重く、YouTube への通信も増えるため）
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[data-yt]");
    if (!a || !a.getAttribute("data-yt") || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    var f = document.createElement("iframe");
    f.src = "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(a.getAttribute("data-yt")) + "?autoplay=1&rel=0";
    f.title = "YouTube";
    f.allow = "autoplay; encrypted-media; picture-in-picture";
    f.allowFullscreen = true;
    f.className = "v-frame";
    a.replaceWith(f);
  });

  // 最近の書き込みと、掲示板ごとの書き込み数
  var rc = document.getElementById("recentComments");
  var counters = document.querySelectorAll("[data-count-for]");
  if (!rc && !counters.length) return;
  fetch("/api/comments.php?recent=1")
    .then(function (r) {
      return r.json();
    })
    .then(function (j) {
      var counts = (j && j.counts) || {};
      Array.prototype.forEach.call(counters, function (el) {
        var n = counts[el.getAttribute("data-count-for")];
        if (n) el.textContent = "（" + n + "）";
      });
      if (!rc) return;
      var items = ((j && j.items) || []).slice(0, 6);
      if (!items.length) {
        rc.innerHTML = '<li class="muted">書き込みはありません</li>';
        return;
      }
      rc.innerHTML = items
        .map(function (c) {
          var body = c.sp ? "（ネタバレ）" : String(c.body || "").slice(0, 40);
          return '<li><a href="' + esc(c.path) + "#c-" + esc(c.no) + '">' + esc(body) + '</a><span class="rc-w">' + esc(c.title) + " ・ " + esc(c.name) + "</span></li>";
        })
        .join("");
    })
    .catch(function () {
      if (rc) rc.innerHTML = '<li class="muted">読み込めませんでした。</li>';
    });
})();
