package com.notestudio.app;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.MimeTypeMap;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * SaveToDownloads —— 把编辑结果写进手机的「下载」目录（APK 专用）。
 *
 * 为什么不走 @capacitor/filesystem：它没有 Directory.Downloads，在 Android 11+ 也写不了
 * 公共下载目录；WebView 又不认 &lt;a download&gt;。所以保存必须由原生侧完成：
 *   - Android 10+（API 29+）：MediaStore.Downloads + RELATIVE_PATH，无需任何权限；
 *   - Android 6~9（API 23~28）：Environment.getExternalStoragePublicDirectory，
 *     需要 WRITE_EXTERNAL_STORAGE 运行时权限（manifest 里 maxSdkVersion=28）。
 *
 * 写入目标固定在 Download/Note Studio/ 子目录，同名直接截断覆盖 —— 重复保存不会堆出
 * 「笔记(1).md 笔记(2).md」，也不会误伤用户放在下载目录里的同名文件。
 *
 * 协议是「分块写入」，避免把几十 MB 的 PDF 一次性塞进单次桥调用：
 *   begin(name) → write(id, base64)* → end(id) → { path }   （失败走 cancel(id)）
 * 插件方法跑在 Capacitor 的后台 HandlerThread 上，文件 IO 不会卡 UI。
 */
@CapacitorPlugin(
    name = "SaveToDownloads",
    permissions = @Permission(strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }, alias = "publicStorage")
)
public class SaveToDownloadsPlugin extends Plugin {

    /** 下载目录下的子目录名（展示路径 Download/Note Studio/…） */
    private static final String SUB_DIR = "Note Studio";

    private static final AtomicInteger SEQ = new AtomicInteger(1);

    /** 一个进行中的保存会话（begin 开、end/cancel 关） */
    private static class Session {
        final String path;       // 展示用相对路径：Download/Note Studio/<name>
        final OutputStream out;
        final Uri uri;           // API 29+ MediaStore 条目（legacy 为 null）
        final boolean pendingDelete; // 本次新建的 IS_PENDING 条目：中断时删掉半成品

        Session(String path, OutputStream out, Uri uri, boolean pendingDelete) {
            this.path = path;
            this.out = out;
            this.uri = uri;
            this.pendingDelete = pendingDelete;
        }
    }

    /** id → 会话。权限回调在主线程、write/end 在后台线程，统一加锁。 */
    private final Map<String, Session> sessions = new HashMap<>();

    // ── 协议：begin ─────────────────────────────────────────────

    @PluginMethod
    public void begin(PluginCall call) {
        String name = sanitizeName(call.getString("name"));
        if (name.isEmpty()) {
            call.reject("文件名无效");
            return;
        }
        // 只有 Android 6~9 才需要存储权限；API 29+ 的 MediaStore 走原生授权模型，无需权限。
        if (Build.VERSION.SDK_INT < 29 && getPermissionState("publicStorage") != PermissionState.GRANTED) {
            requestPermissionForAlias("publicStorage", call, "beginLegacyAfterPermission");
            return;
        }
        synchronized (sessions) {
            if (Build.VERSION.SDK_INT >= 29) {
                beginMediaStore(call, name);
            } else {
                beginLegacy(call, name);
            }
        }
    }

    /** 存储权限请求回来后（授予/拒绝都会回来）重新走 legacy begin；拒绝则直接 reject。 */
    @PermissionCallback
    private void beginLegacyAfterPermission(PluginCall call) {
        if (getPermissionState("publicStorage") != PermissionState.GRANTED) {
            call.reject("没有存储权限，无法写入下载目录");
            return;
        }
        String name = sanitizeName(call.getString("name"));
        if (name.isEmpty()) {
            call.reject("文件名无效");
            return;
        }
        synchronized (sessions) {
            beginLegacy(call, name);
        }
    }

    /** API 29+：MediaStore.Downloads（Scoped Storage，无需权限）。 */
    private void beginMediaStore(PluginCall call, String name) {
        ContentResolver resolver = getContext().getContentResolver();
        String relPath = Environment.DIRECTORY_DOWNLOADS + "/" + SUB_DIR;

        // 已有同名文件 → 打开它并截断覆盖（不产生「副本(1)」）；没有才新建 pending 条目。
        Uri uri = findExisting(resolver, name, relPath);
        boolean pendingDelete = false;
        if (uri == null) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            values.put(MediaStore.MediaColumns.MIME_TYPE, mimeFor(name));
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, relPath);
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            pendingDelete = true;
        }
        if (uri == null) {
            call.reject("无法在下载目录创建文件");
            return;
        }
        try {
            // "wt" = 写入并截断（API 26+；本分支只在 29+ 走，安全）
            OutputStream out = resolver.openOutputStream(uri, "wt");
            if (out == null) {
                if (pendingDelete) resolver.delete(uri, null, null);
                call.reject("无法打开文件写入流");
                return;
            }
            String path = displayPath(name);
            String id = String.valueOf(SEQ.getAndIncrement());
            sessions.put(id, new Session(path, out, uri, pendingDelete));
            JSObject ret = new JSObject();
            ret.put("id", id);
            call.resolve(ret);
        } catch (Exception e) {
            if (pendingDelete) {
                try { resolver.delete(uri, null, null); } catch (Exception ignore) { /* 尽力清理 */ }
            }
            call.reject("打开文件失败：" + e.getMessage());
        }
    }

    /** API 23~28：直接写公共下载目录（已授予 WRITE_EXTERNAL_STORAGE）。 */
    private void beginLegacy(PluginCall call, String name) {
        File dir = new File(
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
            SUB_DIR
        );
        if (!dir.exists() && !dir.mkdirs()) {
            call.reject("无法创建下载目录");
            return;
        }
        File file = new File(dir, name);
        try {
            OutputStream out = new FileOutputStream(file); // 默认截断旧内容
            String id = String.valueOf(SEQ.getAndIncrement());
            // 半成品不删：截断已经发生，删不删旧内容都回不去了，留着下次保存会覆盖
            sessions.put(id, new Session(displayPath(name), out, null, false));
            JSObject ret = new JSObject();
            ret.put("id", id);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("打开文件失败：" + e.getMessage());
        }
    }

    /** 在 Download/Note Studio/ 里找同名文件（只匹配我们的子目录，不碰用户自己的下载）。 */
    private Uri findExisting(ContentResolver resolver, String name, String relPath) {
        String[] projection = { MediaStore.MediaColumns._ID, MediaStore.MediaColumns.RELATIVE_PATH };
        String selection = MediaStore.MediaColumns.DISPLAY_NAME + "=?";
        try (Cursor c = resolver.query(
                MediaStore.Downloads.EXTERNAL_CONTENT_URI, projection, selection, new String[] { name }, null)) {
            while (c != null && c.moveToNext()) {
                String rp = c.getString(1);
                if (rp == null) continue;
                String norm = rp.endsWith("/") ? rp.substring(0, rp.length() - 1) : rp;
                if (norm.equalsIgnoreCase(relPath)) {
                    return ContentUris.withAppendedId(MediaStore.Downloads.EXTERNAL_CONTENT_URI, c.getLong(0));
                }
            }
        } catch (Exception e) {
            // 查询失败按「不存在」处理，下面会尝试新建
        }
        return null;
    }

    // ── 协议：write（分块 base64）────────────────────────────────

    @PluginMethod
    public void write(PluginCall call) {
        String id = call.getString("id");
        String data = call.getString("data");
        Session s = id != null ? sessions.get(id) : null;
        if (s == null) {
            call.reject("保存会话不存在或已结束");
            return;
        }
        try {
            byte[] bytes = Base64.decode(data == null ? "" : data, Base64.DEFAULT);
            synchronized (sessions) {
                s.out.write(bytes);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("写入失败：" + e.getMessage());
        }
    }

    // ── 协议：end / cancel ─────────────────────────────────────

    @PluginMethod
    public void end(PluginCall call) {
        String id = call.getString("id");
        Session s;
        synchronized (sessions) {
            s = id != null ? sessions.remove(id) : null;
        }
        if (s == null) {
            call.reject("保存会话不存在或已结束");
            return;
        }
        try {
            s.out.flush();
            s.out.close();
            if (s.uri != null && Build.VERSION.SDK_INT >= 29) {
                // 清掉 IS_PENDING：文件此时才对文件管理器/其他应用可见
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.IS_PENDING, 0);
                getContext().getContentResolver().update(s.uri, values, null, null);
            }
            JSObject ret = new JSObject();
            ret.put("path", s.path);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("保存失败：" + e.getMessage());
        }
    }

    /** 中断清理：关流；本次新建的 pending 条目删掉（避免留下不可见的半成品）。 */
    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id");
        Session s = null;
        synchronized (sessions) {
            if (id != null) s = sessions.remove(id);
        }
        if (s != null) {
            try { s.out.close(); } catch (Exception ignore) { /* 关失败也继续 */ }
            if (s.pendingDelete && s.uri != null && Build.VERSION.SDK_INT >= 29) {
                try {
                    getContext().getContentResolver().delete(s.uri, null, null);
                } catch (Exception ignore) { /* 删不掉就留给系统清理 */ }
            }
        }
        // 无论会话在不在都算清理完成：JS 侧 cancel 是兜底，不该再抛
        call.resolve();
    }

    // ── 工具 ────────────────────────────────────────────────────

    /** 展示路径：Download/Note Studio/<name>（toast 里给用户看的） */
    private static String displayPath(String name) {
        return Environment.DIRECTORY_DOWNLOADS + "/" + SUB_DIR + "/" + name;
    }

    /**
     * 文件名消毒：只取最后一段路径、去掉控制符与 Windows/Android 非法字符、防 "."/".." 穿越。
     * 空名直接拒绝（由调用方判断）。
     */
    private static String sanitizeName(String raw) {
        if (raw == null) return "";
        String n = raw.trim();
        int slash = Math.max(n.lastIndexOf('/'), n.lastIndexOf('\\'));
        if (slash >= 0) n = n.substring(slash + 1);
        n = n.replaceAll("[\\p{Cntrl}<>:\"|?*]", "_").trim();
        if (n.equals(".") || n.equals("..")) return "";
        if (n.length() > 180) {
            int dot = n.lastIndexOf('.');
            String ext = (dot > 0 && n.length() - dot <= 12) ? n.substring(dot) : "";
            String base = dot > 0 ? n.substring(0, dot) : n;
            n = base.substring(0, Math.min(base.length(), 180 - ext.length())) + ext;
        }
        return n;
    }

    /** 扩展名 → MIME（Android 的表查不到 md/epub 等，先特判再查表，兜底 octet-stream）。 */
    private static String mimeFor(String name) {
        String ext = "";
        int dot = name.lastIndexOf('.');
        if (dot >= 0 && dot < name.length() - 1) {
            ext = name.substring(dot + 1).toLowerCase(Locale.ROOT);
        }
        switch (ext) {
            case "md":
            case "markdown":
                return "text/markdown";
            case "txt":
                return "text/plain";
            case "csv":
                return "text/csv";
            case "epub":
                return "application/epub+zip";
            case "pdf":
                return "application/pdf";
            case "docx":
                return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            case "xlsx":
                return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            case "pptx":
                return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
            default:
                break;
        }
        try {
            String m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
            if (m != null) return m;
        } catch (Exception ignore) {
            // 查表失败走兜底
        }
        return "application/octet-stream";
    }
}
