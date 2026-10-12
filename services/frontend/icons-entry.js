import { createElement, Undo2, Shuffle, RotateCcw, ListChecks, RefreshCw, Upload, X, ZoomIn, FlipHorizontal2, Layers, FileText, Volume2, VolumeX, Expand, Minimize2, GripVertical } from 'lucide';
const icons = { 'undo-2': Undo2, shuffle: Shuffle, 'rotate-ccw': RotateCcw, 'list-checks': ListChecks, 'refresh-cw': RefreshCw, x: X, 'zoom-in': ZoomIn, 'flip-horizontal': FlipHorizontal2, layers: Layers, 'file-text': FileText, 'volume-2': Volume2, 'volume-x': VolumeX, expand: Expand, minimize: Minimize2, grip: GripVertical };
icons.upload = Upload;
window.frankenIcon = name => createElement(icons[name] || icons['list-checks'], { 'aria-hidden': 'true', focusable: 'false', width: 20, height: 20 });
