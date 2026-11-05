export const tools = {
  add: {
    description: 'Add two integers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'integer' }, b: { type: 'integer' } },
      required: ['a', 'b'],
      additionalProperties: false,
    },
    handler: ({ a, b }) => a + b,
  },
};
