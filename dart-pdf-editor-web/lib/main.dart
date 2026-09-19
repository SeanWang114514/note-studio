import 'dart:async';
import 'dart:js_interop';
import 'dart:typed_data';

import 'package:dart_pdf_editor/dart_pdf_editor.dart';
import 'package:dart_pdf_editor_assets/dart_pdf_editor_assets.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:web/web.dart' as web;

const _openMessage = 'dart-pdf-editor:open';
const _readyMessage = 'dart-pdf-editor:ready';
const _savedMessage = 'dart-pdf-editor:saved';
const _errorMessage = 'dart-pdf-editor:error';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const BridgeApp());
}

class BridgeApp extends StatefulWidget {
  const BridgeApp({super.key});
  @override State<BridgeApp> createState() => _BridgeAppState();
}

class _BridgeAppState extends State<BridgeApp> {
  Uint8List? _bytes;
  String _name = 'document.pdf';
  StreamSubscription<web.MessageEvent>? _subscription;
  bool _frameReady = false;
  bool _assetsRegistered = false;
  final PdfViewerController _viewerController = PdfViewerController();

  @override
  void initState() {
    super.initState();
    _subscription = web.window.onMessage.listen(_onMessage);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _frameReady = true;
      web.document.getElementById('loading')?.remove();
      _post(<String, Object?>{'type': _readyMessage});
    });
  }

  void _onMessage(web.MessageEvent event) {
    if (event.source != web.window.parent || event.origin != web.window.location.origin) return;
    final data = event.data.dartify();
    if (data is! Map) return;
    if (data['type'] == 'dart-pdf-editor:ping') {
      if (_frameReady) _post(<String, Object?>{'type': _readyMessage});
      return;
    }
    if (data['type'] != _openMessage) return;
    try {
      final raw = data['bytes'];
      final bytes = raw is Uint8List
          ? Uint8List.fromList(raw)
          : raw is ByteBuffer
          ? Uint8List.fromList(raw.asUint8List())
          : raw is List
          ? Uint8List.fromList(raw.map((value) => (value as num).toInt()).toList())
          : throw StateError('消息中没有有效的 PDF 字节');
      final name = data['name']?.toString() ?? 'document.pdf';
      if (!_assetsRegistered) {
        registerBundledEditorAssets(webWorker: true);
        _assetsRegistered = true;
      }
      if (!mounted) return;
      Timer.run(() {
        if (!mounted) return;
        setState(() { _bytes = bytes; _name = name; });
      });
    } catch (error, stack) {
      _post(<String, Object?>{'type': _errorMessage, 'message': 'PDF 编辑器初始化失败: $error\n$stack'});
    }
  }

  void _post(Map<String, Object?> message) {
    web.window.parent?.postMessage(message.jsify(), web.window.location.origin.toJS);
  }

  @override
  void dispose() {
    _subscription?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      scrollBehavior: const _PdfScrollBehavior(),
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xff1769aa), brightness: Brightness.light),
        useMaterial3: true,
        scaffoldBackgroundColor: Colors.white,
      ),
      localizationsDelegates: const [DartPdfEditorLocalizations.delegate, GlobalMaterialLocalizations.delegate, GlobalWidgetsLocalizations.delegate, GlobalCupertinoLocalizations.delegate],
      supportedLocales: const [Locale('zh'), Locale('en')],
      home: _bytes == null ? const _Waiting() : PdfEditorView(
        key: ValueKey(_name),
        bytes: _bytes!,
        alwaysAllowSave: true,
        backgroundColor: Colors.white,
        pageColor: Colors.transparent,
        pageOverlayBuilder: (context, pageIndex, geometry) => const [
          Positioned.fill(
            child: IgnorePointer(
              child: DecoratedBox(
                decoration: BoxDecoration(
                  border: Border.fromBorderSide(BorderSide(color: Color(0xFFCBD2DA), width: 1)),
                ),
              ),
            ),
          ),
        ],
        features: const PdfEditorFeatures(pageEditing: false, thumbnails: true, pageNumber: false),
        viewerController: _viewerController,
        toolbarBuilder: (context, controller, viewer) => Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Material(
              color: Colors.white,
              elevation: 2,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    _ZoomControls(viewer: viewer),
                    const SizedBox(width: 8),
                    _LabeledToolButton(icon: Icons.mic_none, label: '语音识别', onPressed: () => _post(<String, Object?>{'type': 'dart-pdf-editor:voice'})),
                    _LabeledToolButton(icon: Icons.draw_outlined, label: '手写识别', onPressed: () => _post(<String, Object?>{'type': 'dart-pdf-editor:handwriting-ocr'})),

                    const SizedBox(width: 8),
                    _PageNavigation(viewer: viewer),
                  ],
                ),
              ),
            ),
            PdfEditingToolbar(
              controller: controller,
              viewerController: viewer,
              onSave: (bytes) => _post(<String, Object?>{'type': _savedMessage, 'name': _name, 'bytes': bytes}),
            ),
          ],
        ),
        onSave: (bytes) => _post(<String, Object?>{'type': _savedMessage, 'name': _name, 'bytes': bytes}),
      ),
    );
  }

  Future<void> _showOcrInput(BuildContext context) async {
    await showDialog<void>(context: context, builder: (context) => const _OcrDialog());
  }

  Future<void> _showSpeechInput(BuildContext context, PdfEditingController controller) async {
    final text = await showDialog<String>(
      context: context,
      builder: (context) => const _SpeechInputDialog(),
    );
    if (!mounted || text == null || text.trim().isEmpty) return;
    // The built-in editor has no public text-tool enum in this version.
    // Keep the captured text available as a confirmation until a text annotation
    // insertion API is exposed by the package.
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('语音输入内容：${text.trim()}')));
  }
}

class _SpeechInputDialog extends StatefulWidget {
  const _SpeechInputDialog();
  @override State<_SpeechInputDialog> createState() => _SpeechInputDialogState();
}

class _SpeechInputDialogState extends State<_SpeechInputDialog> {
  final _controller = TextEditingController();
  bool _listening = false;
  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('语音输入'),
    content: ConstrainedBox(
      constraints: BoxConstraints(
        maxWidth: 520,
        maxHeight: MediaQuery.sizeOf(context).height * 0.58,
      ),
      child: Scrollbar(
        thumbVisibility: true,
        child: SingleChildScrollView(
          primary: true,
          padding: const EdgeInsets.only(right: 8),
          child: TextField(
            controller: _controller,
            autofocus: true,
            minLines: 5,
            maxLines: null,
            keyboardType: TextInputType.multiline,
            decoration: const InputDecoration(
              hintText: '请点击麦克风后说话，也可以直接输入文字',
              alignLabelWithHint: true,
            ),
          ),
        ),
      ),
    ),
    actions: [
      IconButton(tooltip: '开始录音', icon: Icon(_listening ? Icons.stop : Icons.mic), onPressed: () => setState(() => _listening = !_listening)),
      TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
      FilledButton(onPressed: () => Navigator.pop(context, _controller.text), child: const Text('使用文字')),
    ],
  );
  @override void dispose() { _controller.dispose(); super.dispose(); }
}

class _LabeledToolButton extends StatelessWidget {
  const _LabeledToolButton({required this.icon, required this.label, required this.onPressed});
  final IconData icon;
  final String label;
  final VoidCallback onPressed;
  @override
  Widget build(BuildContext context) => Tooltip(
    message: label,
    child: TextButton.icon(
      onPressed: onPressed,
      icon: Icon(icon, size: 18),
      label: Text(label, style: const TextStyle(fontSize: 12)),
      style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 8)),
    ),
  );
}

class _OcrDialog extends StatelessWidget {
  const _OcrDialog();
  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('文字识别'),
    content: ConstrainedBox(
      constraints: BoxConstraints(maxWidth: 520, maxHeight: MediaQuery.sizeOf(context).height * 0.58),
      child: Scrollbar(
        thumbVisibility: true,
        child: SingleChildScrollView(
          padding: const EdgeInsets.only(right: 8),
          child: const TextField(
            minLines: 8,
            maxLines: null,
            keyboardType: TextInputType.multiline,
            decoration: InputDecoration(hintText: '识别结果将显示在这里，可滚动查看和编辑', alignLabelWithHint: true),
          ),
        ),
      ),
    ),
    actions: [
      TextButton(onPressed: () => Navigator.pop(context), child: const Text('关闭')),
      FilledButton(onPressed: () => Navigator.pop(context), child: const Text('使用结果')),
    ],
  );
}

class _ZoomControls extends StatelessWidget {
  const _ZoomControls({required this.viewer});
  final PdfViewerController viewer;

  void _change(double factor) {
    final zoom = viewer.scrollMetrics?.zoom ?? 1.0;
    viewer.setZoom((zoom * factor).clamp(0.5, 6.0));
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: viewer.viewportChanges,
    builder: (context, _) {
      final zoom = viewer.scrollMetrics?.zoom ?? 1.0;
      final percent = (zoom * 100).round();
      return Row(mainAxisSize: MainAxisSize.min, children: [
        IconButton(
          tooltip: '缩小',
          icon: const Icon(Icons.remove, size: 18),
          onPressed: () => _change(1 / 1.2),
          visualDensity: VisualDensity.compact,
        ),
        Text('$percent%', style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
        IconButton(
          tooltip: '放大',
          icon: const Icon(Icons.add, size: 18),
          onPressed: () => _change(1.2),
          visualDensity: VisualDensity.compact,
        ),
        IconButton(
          tooltip: '重置缩放',
          icon: const Icon(Icons.refresh, size: 17),
          onPressed: (zoom - 1).abs() > 0.005 ? viewer.resetZoom : null,
          visualDensity: VisualDensity.compact,
        ),
      ]);
    },
  );
}

class _PageNavigation extends StatelessWidget {
  const _PageNavigation({required this.viewer});
  final PdfViewerController viewer;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: viewer.viewportChanges,
    builder: (context, _) {
      final metrics = viewer.scrollMetrics;
      final count = metrics?.pageCount ?? 0;
      final page = metrics == null ? 0 : metrics.currentPage + 1;
      return Row(mainAxisSize: MainAxisSize.min, children: [
        IconButton(
          tooltip: '上一页',
          icon: const Icon(Icons.keyboard_arrow_up),
          onPressed: page > 1 ? () => viewer.animateToPage(page - 2) : null,
        ),
        Text('$page / $count', style: const TextStyle(fontSize: 12)),
        IconButton(
          tooltip: '下一页',
          icon: const Icon(Icons.keyboard_arrow_down),
          onPressed: page > 0 && page < count ? () => viewer.animateToPage(page) : null,
        ),
      ]);
    },
  );
}

class _PdfScrollBehavior extends MaterialScrollBehavior {
  const _PdfScrollBehavior();
  @override Set<PointerDeviceKind> get dragDevices => const <PointerDeviceKind>{PointerDeviceKind.mouse, PointerDeviceKind.touch, PointerDeviceKind.trackpad, PointerDeviceKind.stylus};
  @override ScrollPhysics getScrollPhysics(BuildContext context) => const BouncingScrollPhysics(parent: AlwaysScrollableScrollPhysics());
}

class _Waiting extends StatelessWidget {
  const _Waiting();
  @override Widget build(BuildContext context) => const Scaffold(body: Center(child: CircularProgressIndicator()));
}
