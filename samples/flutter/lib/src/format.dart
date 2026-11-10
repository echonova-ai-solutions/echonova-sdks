/// Number formatting for the screens.
library;

/// Formats [value] with at most two decimals: `3`, `0.5`, `12.25`.
String formatNumber(num value) =>
    value.toStringAsFixed(2).replaceFirst(RegExp(r'\.?0+$'), '');
