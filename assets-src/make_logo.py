from PIL import Image

img = Image.open('build/icon.png')
img.resize((192, 192), Image.LANCZOS).save('src/renderer/assets/logo.png')
print('logo.png ok')
