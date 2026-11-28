package com.minimal41.tools;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.json.JSONObject;

/**
 * Tools のページの自動更新。
 *
 * アプリには作った時点のページ（assets/public）が入っている。
 * 起動時とアプリに戻ったときに、公開している最新のページの情報（web.json）を確かめ、
 * 新しければ web.zip をダウンロードしてアプリの中に展開し、次の起動から（または「今すぐ反映」で）それを使う。
 *
 * - Android 側の仕組み（このフォルダの Java など）が変わった版は、ページだけ入れ替えると動かないので取り込まず、
 *   「アプリの更新があります」と知らせる（nativeHash で見分ける）。
 * - 新しいページで正しく起動できなかったら（ページから ready が届かなかったら）、前のページに戻す。
 * - 新しい APK を入れたときは、Capacitor が自動でアプリに入っているページに戻す。
 */
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {

    private static final String DEFAULT_MANIFEST = "https://github.com/minimal41/tools/releases/download/android-latest/web.json";
    private static final String DEFAULT_APK_PAGE = "https://github.com/minimal41/tools/releases/tag/android-latest";
    private static final String CAP_PREFS = "CapWebViewSettings"; // Capacitor が起動時に読む設定
    private static final String CAP_SERVER_PATH = "serverBasePath";
    private static final String PREFS = "app_update";
    private static final long CHECK_INTERVAL_MS = 30 * 60 * 1000L;
    private static final long VERIFY_TIMEOUT_MS = 20_000L;

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    private String bundledVersion = "";
    private String bundledNativeHash = "";
    private String running = "";              // いま表示しているページの版
    private boolean nativeUpdate = false;     // アプリ本体（APK）の更新がある
    private String remoteVersion = null;
    private volatile boolean checking = false;
    private long lastCheck = 0;
    private String lastError = null;
    private Runnable verifyTimer;

    @Override
    public void load() {
        readBundled();
        SharedPreferences p = prefs();
        String capPath = capPrefs().getString(CAP_SERVER_PATH, "");
        String installedPath = p.getString("installed_path", "");
        if (capPath != null && !capPath.isEmpty() && capPath.equals(installedPath) && new File(capPath, "index.html").exists()) {
            running = p.getString("installed_version", bundledVersion);
        } else {
            // 新しい APK を入れた直後など：アプリに入っているページを使っている
            running = bundledVersion;
            p.edit().remove("installed_path").remove("installed_version").remove("pending_verify").apply();
        }
        // 初めて使う版なら、ちゃんと起動できたか確かめる
        if (running.equals(p.getString("pending_verify", null))) startVerify(running);

        main.postDelayed(() -> check(null), 3000);
    }

    @Override
    protected void handleOnResume() {
        if (System.currentTimeMillis() - lastCheck > CHECK_INTERVAL_MS) check(null);
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private SharedPreferences capPrefs() {
        return getContext().getSharedPreferences(CAP_PREFS, Context.MODE_PRIVATE);
    }

    private String manifestUrl() {
        return getConfig().getString("manifestUrl", DEFAULT_MANIFEST);
    }

    private String apkPage() {
        return getConfig().getString("apkPage", DEFAULT_APK_PAGE);
    }

    private void readBundled() {
        try (InputStream in = getContext().getAssets().open("public/app-version.json")) {
            JSONObject v = new JSONObject(new String(readAll(in), "UTF-8"));
            bundledVersion = v.optString("version", "");
            bundledNativeHash = v.optString("nativeHash", "");
        } catch (Exception e) {
            bundledVersion = "";
            bundledNativeHash = "";
        }
    }

    /* ---------------- ページから呼ぶ ---------------- */

    /** ページが正しく開けたら呼ぶ（新しい版の確認が済む） */
    @PluginMethod
    public void ready(PluginCall call) {
        main.post(() -> {
            SharedPreferences p = prefs();
            if (running.equals(p.getString("pending_verify", null))) {
                p.edit().remove("pending_verify").apply();
                if (verifyTimer != null) main.removeCallbacks(verifyTimer);
                verifyTimer = null;
                cleanup();
            }
            call.resolve(info());
        });
    }

    @PluginMethod
    public void getInfo(PluginCall call) {
        main.post(() -> call.resolve(info()));
    }

    /** すぐに確かめる */
    @PluginMethod
    public void checkNow(PluginCall call) {
        main.post(() -> check(call));
    }

    /** ダウンロード済みの新しいページに今すぐ切り替える（ページを読み込み直す） */
    @PluginMethod
    public void apply(PluginCall call) {
        main.post(() -> {
            SharedPreferences p = prefs();
            String version = p.getString("installed_version", null);
            String path = p.getString("installed_path", null);
            if (version == null || path == null || version.equals(running) || !new File(path, "index.html").exists()) {
                call.resolve(info());
                return;
            }
            running = version;
            startVerify(version);
            call.resolve(info());
            bridge.setServerBasePath(path);
        });
    }

    /** APK のダウンロードページをブラウザで開く */
    @PluginMethod
    public void openApkPage(PluginCall call) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(apkPage()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("ブラウザを開けませんでした。", e);
        }
    }

    private JSObject info() {
        SharedPreferences p = prefs();
        String installed = p.getString("installed_version", null);
        JSObject r = new JSObject();
        r.put("running", running);
        r.put("bundled", bundledVersion);
        r.put("remote", remoteVersion);
        r.put("readyToApply", installed != null && !installed.equals(running));
        r.put("nativeUpdate", nativeUpdate);
        r.put("apkPage", apkPage());
        r.put("checking", checking);
        r.put("lastCheck", lastCheck);
        r.put("error", lastError);
        return r;
    }

    /* ---------------- 確認・ダウンロード ---------------- */

    private void check(PluginCall call) {
        if (checking) {
            if (call != null) call.resolve(info());
            return;
        }
        checking = true;
        worker.execute(() -> {
            String error = null;
            boolean downloaded = false;
            try {
                JSONObject m = new JSONObject(new String(get(manifestUrl() + "?t=" + System.currentTimeMillis()), "UTF-8"));
                String version = m.optString("version", "");
                String nativeHash = m.optString("nativeHash", "");
                remoteVersion = version;
                nativeUpdate = !nativeHash.isEmpty() && !bundledNativeHash.isEmpty() && !nativeHash.equals(bundledNativeHash);
                SharedPreferences p = prefs();
                Set<String> bad = p.getStringSet("bad_versions", new HashSet<>());
                String installed = p.getString("installed_version", null);
                if (!nativeUpdate && !version.isEmpty() && !version.equals(running) && !version.equals(installed) && !bad.contains(version)) {
                    if (version.equals(bundledVersion)) {
                        // アプリに入っているページと同じ：入れていた更新をやめて元に戻すだけ
                        capPrefs().edit().putString(CAP_SERVER_PATH, "").apply();
                        p.edit().remove("installed_path").remove("installed_version").apply();
                    } else {
                        String zipName = m.optString("zip", "web.zip");
                        String zipUrl = new URL(new URL(manifestUrl()), zipName).toString();
                        File dir = download(zipUrl, m.optString("zipSha256", ""), version);
                        // 次の起動からこのページを使う
                        p.edit()
                            .putString("installed_version", version)
                            .putString("installed_path", dir.getAbsolutePath())
                            .putString("pending_verify", version)
                            .apply();
                        capPrefs().edit().putString(CAP_SERVER_PATH, dir.getAbsolutePath()).apply();
                        downloaded = true;
                    }
                }
            } catch (Exception e) {
                error = e.getMessage() == null ? e.toString() : e.getMessage();
            }
            final String err = error;
            final boolean got = downloaded;
            main.post(() -> {
                checking = false;
                lastCheck = System.currentTimeMillis();
                lastError = err;
                JSObject i = info();
                notifyListeners("update", i, true);
                if (call != null) call.resolve(i);
                if (got) cleanup();
            });
        });
    }

    private File download(String zipUrl, String sha256, String version) throws Exception {
        File root = new File(getContext().getFilesDir(), "web");
        File tmp = new File(root, "tmp-" + System.currentTimeMillis());
        File dest = new File(root, version.replaceAll("[^A-Za-z0-9_.-]", "_"));
        byte[] zip = get(zipUrl);
        if (!sha256.isEmpty()) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            StringBuilder hex = new StringBuilder();
            for (byte b : md.digest(zip)) hex.append(String.format("%02x", b));
            if (!hex.toString().equalsIgnoreCase(sha256)) throw new Exception("ダウンロードしたデータが壊れています。");
        }
        deleteRecursive(tmp);
        tmp.mkdirs();
        String base = tmp.getCanonicalPath() + File.separator;
        try (ZipInputStream zin = new ZipInputStream(new java.io.ByteArrayInputStream(zip))) {
            ZipEntry e;
            byte[] buf = new byte[64 * 1024];
            while ((e = zin.getNextEntry()) != null) {
                File out = new File(tmp, e.getName());
                if (!out.getCanonicalPath().startsWith(base)) throw new Exception("不正なファイル名: " + e.getName());
                if (e.isDirectory()) {
                    out.mkdirs();
                    continue;
                }
                File parent = out.getParentFile();
                if (parent != null) parent.mkdirs();
                try (OutputStream os = new FileOutputStream(out)) {
                    int n;
                    while ((n = zin.read(buf)) > 0) os.write(buf, 0, n);
                }
            }
        }
        if (!new File(tmp, "index.html").exists()) {
            deleteRecursive(tmp);
            throw new Exception("ページのデータが足りません。");
        }
        deleteRecursive(dest);
        if (!tmp.renameTo(dest)) {
            deleteRecursive(tmp);
            throw new Exception("保存できませんでした。");
        }
        return dest;
    }

    private static byte[] get(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15_000);
        c.setReadTimeout(60_000);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("Cache-Control", "no-cache");
        try {
            int code = c.getResponseCode();
            if (code != 200) throw new Exception("サーバーの応答 " + code);
            try (InputStream in = c.getInputStream()) {
                return readAll(in);
            }
        } finally {
            c.disconnect();
        }
    }

    private static byte[] readAll(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }

    /* ---------------- 起動の確認と後かたづけ ---------------- */

    /** 新しい版に切り替えたら、決まった時間内にページから ready が届くか見張る。届かなければ元に戻す */
    private void startVerify(String version) {
        if (verifyTimer != null) main.removeCallbacks(verifyTimer);
        verifyTimer = () -> {
            verifyTimer = null;
            SharedPreferences p = prefs();
            if (!version.equals(p.getString("pending_verify", null))) return;
            Set<String> bad = new HashSet<>(p.getStringSet("bad_versions", new HashSet<>()));
            bad.add(version);
            p.edit()
                .putStringSet("bad_versions", bad)
                .remove("pending_verify")
                .remove("installed_version")
                .remove("installed_path")
                .apply();
            capPrefs().edit().putString(CAP_SERVER_PATH, "").apply();
            running = bundledVersion;
            bridge.setServerAssetPath("public");
        };
        main.postDelayed(verifyTimer, VERIFY_TIMEOUT_MS);
    }

    /** 使っていない古い版を消す */
    private void cleanup() {
        String keep = prefs().getString("installed_path", "");
        String now = bridge.getServerBasePath();
        worker.execute(() -> {
            File[] dirs = new File(getContext().getFilesDir(), "web").listFiles();
            if (dirs == null) return;
            for (File d : dirs) {
                String path = d.getAbsolutePath();
                if (path.equals(keep) || path.equals(now) || d.getName().startsWith("tmp-")) continue;
                deleteRecursive(d);
            }
        });
    }

    private static void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        File[] children = f.listFiles();
        if (children != null) for (File c : children) deleteRecursive(c);
        f.delete();
    }
}
