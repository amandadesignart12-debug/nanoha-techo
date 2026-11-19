/* アプリの設定（ここだけ書き換えればOK） */
window.APP_CONFIG = {
  // Muse が毎日更新する catalog.json の場所。同じフォルダに置く場合はこのまま。
  catalogUrl: 'catalog.json',

  // 「出場する／検討中」を親子で共有するための Supabase 設定（SETUP.md 参照）。
  // 空のままだと、その端末の中だけに保存されます。
  supabaseUrl: 'https://wslyxeslbbdurteuaneg.supabase.co',
  supabaseAnonKey: 'sb_publishable_ZgpvAOgNijrBrUEhOoUH0g_KcKqB5Ms',
  supabaseTable: 'selections'
};
