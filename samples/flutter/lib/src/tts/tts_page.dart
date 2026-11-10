/// The Text to Speech screen.
library;

import 'package:echonova/echonova.dart';
import 'package:flutter/material.dart';

import '../format.dart';
import 'tts_controller.dart';

/// Pick a voice, type, speak; stop at any time.
class TtsPage extends StatefulWidget {
  /// Shows [controller].
  const TtsPage({super.key, required this.controller});

  /// The screen's state.
  final TtsController controller;

  @override
  State<TtsPage> createState() => _TtsPageState();
}

class _TtsPageState extends State<TtsPage> {
  final TextEditingController _text = TextEditingController();

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    return ListenableBuilder(
      listenable: Listenable.merge([controller, _text]),
      builder: (context, _) {
        final theme = Theme.of(context);
        final status = controller.status;
        final length = _text.text.trim().runes.length;
        final tooLong = length > TtsController.maxTextLength;
        final voice = controller.voices
            .where((voice) => voice.id == controller.voiceId)
            .firstOrNull;
        final canSpeak = controller.voiceId != null && length > 0 && !tooLong;
        return ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Row(
              children: [
                Expanded(
                  child: DropdownButtonFormField<String>(
                    key: const Key('voice'),
                    initialValue: controller.voiceId,
                    isExpanded: true,
                    decoration: const InputDecoration(labelText: 'Voice'),
                    items: [
                      for (final voice in controller.voices)
                        DropdownMenuItem(
                          value: voice.id,
                          child: Text(
                            _voiceLabel(voice),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                    ],
                    onChanged: (id) {
                      if (id != null) controller.selectVoice(id);
                    },
                  ),
                ),
                IconButton(
                  tooltip: 'Reload voices',
                  onPressed: controller.loadingVoices
                      ? null
                      : controller.loadVoices,
                  icon: const Icon(Icons.refresh),
                ),
              ],
            ),
            const SizedBox(height: 16),
            TextField(
              key: const Key('text'),
              controller: _text,
              minLines: 3,
              maxLines: 8,
              textDirection: voice?.language == 'ar'
                  ? TextDirection.rtl
                  : TextDirection.ltr,
              decoration: InputDecoration(
                labelText: 'Text',
                hintText: 'Type something to say',
                border: const OutlineInputBorder(),
                counterText: '$length / ${TtsController.maxTextLength}',
                errorText: tooLong
                    ? 'At most ${TtsController.maxTextLength} characters'
                    : null,
              ),
            ),
            const SizedBox(height: 16),
            Wrap(
              spacing: 12,
              runSpacing: 8,
              children: [
                FilledButton.icon(
                  key: const Key('speak'),
                  // Speaking again while speaking replaces the audio.
                  onPressed: canSpeak
                      ? () => controller.speak(_text.text)
                      : null,
                  icon: const Icon(Icons.play_arrow),
                  label: const Text('Speak'),
                ),
                OutlinedButton.icon(
                  key: const Key('stop'),
                  onPressed: status == TtsStatus.idle ? null : controller.stop,
                  icon: const Icon(Icons.stop),
                  label: const Text('Stop'),
                ),
              ],
            ),
            const SizedBox(height: 16),
            if (controller.loadingVoices || status == TtsStatus.connecting)
              const LinearProgressIndicator(),
            if (status == TtsStatus.speaking)
              Text('Speaking…', style: theme.textTheme.titleMedium),
            if (controller.report case final report?)
              Text(_describe(report), key: const Key('report')),
            if (controller.error case final error?)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  error,
                  key: const Key('error'),
                  style: TextStyle(color: theme.colorScheme.error),
                ),
              ),
          ],
        );
      },
    );
  }
}

String _voiceLabel(Voice voice) {
  final name = voice.displayName ?? voice.name ?? voice.id;
  final details = [?voice.language?.toUpperCase(), ?voice.gender];
  return details.isEmpty ? name : '$name (${details.join(', ')})';
}

String _describe(SpeechReport report) {
  final result = report.result;
  return [
    switch (result.outcome) {
      SynthesisOutcome.completed => 'Done',
      SynthesisOutcome.cancelled => 'Stopped',
      SynthesisOutcome.superseded => 'Replaced',
    },
    if (result.durationSeconds case final seconds?)
      '${formatNumber(seconds)} s of audio',
    if (report.ttfb case final ttfb?)
      'first audio after ${ttfb.inMilliseconds} ms',
    if (result.creditsConsumed case final credits?)
      '${formatNumber(credits)} credits'
    else if (result.charged == false)
      'not charged',
    if (result.sampleRate case final rate?) '$rate Hz',
  ].join(' · ');
}
