export default {
  routes: [
    {
      method: 'POST',
      path: '/catalog-import/product',
      handler: 'catalog-import.product',
      config: {
        policies: [],
      },
    },
  ],
};
