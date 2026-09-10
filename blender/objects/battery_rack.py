"""Standard SD-BT, workbook 800×1000×2000mm. Legacy single-model entry point."""
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from facilities import build
build('battery-rack', sys.argv[sys.argv.index('--') + 1])
