# Image Detection Module

## Purpose

The Image detection module detect images in a PDF document when PdfMiner extractor is selected.

## What it does

It matches every image detected by PdfMiner to the correct image file and appends image URI to all image elements in the document.

## Dependencies

MuPDF: `mutool extract` is used to extract all image files from a PDF.

## How it works

1. It uses the name of every image (figure name) detected by PdfMiner and tries to match with a single image identifier extracted by 'dumppdf'.

```
//'Image17' will be used to match image XObject using dumppdf
<figure name="Image17" bbox="72.000,244.190,373.280,506.640">
<image width="301" height="262" />
</figure>
```

2. `dumppdf` dumps the internal contents of a PDF file in pseudo-XML format, using this data the module tries to match each figure name with an image file name.

```
<key>XObject</key>
<value><dict size="1">
<key>Image17</key>
<value><ref id="17" /></value> // '17' will be used to match a image file named 'Img-17' extracted by MuPDF
</dict></value>
```

## Accuracy

Depends on the way PDF was built, if PDF is build using good practices the accuracy is **good**. 

## Limitations

- The module could not detect correct image if PDF was built using same image name (figure name) for all images.
- Some PDF can use more than one image file (one alpha image with one background image) to generate one visual image in PDF, in that case the module will detect both images.

##TODO

- Add image detection for other extractors (Abby, Pdf.js...)
- Improve image detection for PDF's using same figure name for more than one image.
- Allow API /markdown end point to download a Zip when md contains images.
