export default {
  compilerOptions: {
    // Pages are remounted (keyed) when their route params change, so reading props once
    // at the top of a page component is intentional.
    warningFilter: (w) => w.code !== 'state_referenced_locally',
  },
};
