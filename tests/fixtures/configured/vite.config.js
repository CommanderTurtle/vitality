export default {
  plugins: [{
    name: "fixture-marker",
    transformIndexHtml(html) {
      return html.replace("</head>", '<meta name="fixture-config" content="loaded"></head>');
    },
  }],
};
